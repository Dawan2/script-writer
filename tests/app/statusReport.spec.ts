import { describe, expect, it } from 'vitest';
import { createProjectMeta, type ProjectMeta } from '../../src/core/model/project.js';
import type { WorkflowStep } from '../../src/core/model/workflow.js';
import type { ProjectFailure, ProjectStatus } from '../../src/app/workflow/engine.js';
import { isSwError, type SwError } from '../../src/app/errors/registry.js';
import { renderError } from '../../src/app/errors/render.js';
import {
  FIRST_SCENE_COMMAND,
  failProject,
  nextActionCommand,
  renderStatusReport,
  suggestNextSceneId,
} from '../../src/app/workflow/statusReport.js';

/** W3 集成迁移：renderProjectFailure 已由 failProject（fail() 唯一入口）取代——
 * 捕获抛出的 SwError 并经统一渲染层还原为三段式文本，供既有断言原样核验。 */
function renderFailure(failure: ProjectFailure, projectDir = '/tmp/somewhere'): string[] {
  try {
    failProject(failure, projectDir);
  } catch (error) {
    expect(isSwError(error)).toBe(true);
    return renderError(error as SwError).split('\n');
  }
}

function statusOf(
  step: WorkflowStep,
  scenesDone: string[],
  sceneIds: string[],
  outlineExists = true,
): ProjectStatus {
  const base = createProjectMeta({ title: '我的短片', created: '2026-08-27' });
  const meta: ProjectMeta = { ...base, progress: { step, scenesDone } };
  return {
    meta,
    disk: { outlineExists, sceneIds },
    scenes: { done: scenesDone.length, total: sceneIds.length },
  };
}

describe('app/workflow/statusReport：下一步命令（SPEC-02 可复制约束）', () => {
  it('所有状态下建议命令均以 sw 开头且不含 <占位符>', () => {
    const cases: ProjectStatus[] = [
      statusOf('init', [], []),
      statusOf('outline', [], [], false),
      statusOf('draft', [], []),
      statusOf('draft', ['010'], ['010']),
      statusOf('revise', ['010'], ['010']),
      statusOf('export', ['010'], ['010']),
    ];
    for (const status of cases) {
      const command = nextActionCommand(status);
      expect(command.startsWith('sw ')).toBe(true);
      expect(command).not.toContain('<');
    }
  });

  it('outline 阶段建议 sw outline；export 阶段建议 sw export', () => {
    expect(nextActionCommand(statusOf('outline', [], [], false))).toBe('sw outline');
    expect(nextActionCommand(statusOf('export', ['010'], ['010']))).toBe('sw export');
  });

  it('draft 空态给出完整示例命令（P1 §6.3 空态三要素）', () => {
    expect(nextActionCommand(statusOf('draft', [], []))).toBe(FIRST_SCENE_COMMAND);
    expect(FIRST_SCENE_COMMAND).toBe('sw draft 010 --title "开场"');
  });

  it('draft 期建议细化（SPEC-05 §4.4-4）：有场未标完成 → 首个未完成场的 --done 命令', () => {
    // 断言随 SPEC-05 迁移期望文案（集成图纪律：迁移不删除）；
    // 原断言的 suggestNextSceneId 步长 10 推算保留在下方独立锁。
    expect(nextActionCommand(statusOf('draft', ['010'], ['010', '020']))).toBe('sw draft 020 --done');
    expect(suggestNextSceneId([])).toBe('010');
    expect(suggestNextSceneId(['010', '020'])).toBe('030');
  });

  it('draft 期：全部完成且未达 expectedSceneCount → 建议下一场（GAP-03 分母消费）', () => {
    const base = statusOf('draft', ['010'], ['010']);
    const status: ProjectStatus = {
      ...base,
      meta: { ...base.meta, expectedSceneCount: 3 },
    };
    expect(nextActionCommand(status)).toBe('sw draft 020');
  });

  it('draft 期：全部完成且已达/缺省预计场数 → 建议 sw export（revise 未注册前不落 sw revise，SPEC-05 §4.4-4）', () => {
    expect(nextActionCommand(statusOf('draft', ['010'], ['010']))).toBe('sw export');
    const base = statusOf('draft', ['010', '020'], ['010', '020']);
    const reached: ProjectStatus = {
      ...base,
      meta: { ...base.meta, expectedSceneCount: 2 },
    };
    expect(nextActionCommand(reached)).toBe('sw export');
  });

  it('revise 阶段给出可执行的 --force 命令（具体场编号，非占位符）', () => {
    expect(nextActionCommand(statusOf('revise', ['010'], ['010', '020']))).toBe(
      'sw draft 010 --force',
    );
  });
});

describe('app/workflow/statusReport：成功态渲染', () => {
  it('输出含标题、当前步骤、场景完成度；末行为可复制命令（SPEC-02 验收要点）', () => {
    const lines = renderStatusReport(statusOf('draft', ['010'], ['010', '020', '030']));
    const text = lines.join('\n');
    expect(text).toContain('我的短片');
    expect(text).toContain('draft');
    expect(text).toContain('1/3 场已完成');
    const last = lines[lines.length - 1];
    expect(last?.startsWith('sw ')).toBe(true);
    expect(last).not.toContain('<');
  });

  it('步骤序号按五步词汇表标注（draft = 第 3/5 步）', () => {
    const lines = renderStatusReport(statusOf('draft', [], []));
    expect(lines.join('\n')).toContain('第 3/5 步');
  });
});

describe('app/workflow/statusReport：失败态三段式（W3 集成后经 SPEC-03 框架 fail() 统一渲染）', () => {
  it('not-a-project → SW-E011 + 原因 + 怎么办（含查找位置）', () => {
    const text = renderFailure({ ok: false, reason: 'not-a-project' }, '/tmp/somewhere').join('\n');
    expect(text).toContain('SW-E011');
    expect(text).toContain('原因');
    expect(text).toContain('怎么办');
    expect(text).toContain('sw init');
    expect(text).toContain('/tmp/somewhere');
  });

  it('schema-incompatible → SW-E020 + 双方版本', () => {
    const text = renderFailure({
      ok: false,
      reason: 'schema-incompatible',
      found: 2,
      expected: 1,
    }).join('\n');
    expect(text).toContain('SW-E020');
    // 迁移说明：注册表模板措辞为「schema 版本是 {found}…支持的是 schema {supported}」，
    // 断言意图不变（双方版本必须同时可见），字面从 engine 版的 "schema: 2/1" 迁为注册表文案。
    expect(text).toContain('schema 版本是 2');
    expect(text).toContain('schema 1');
  });

  it('malformed → 每条 issue 均出现在原因段（SW-E022）', () => {
    const issues = [
      'title 必须是非空字符串',
      'progress.step 必须是 init|outline|draft|revise|export 之一',
    ];
    const lines = renderFailure({ ok: false, reason: 'malformed', issues });
    const text = lines.join('\n');
    expect(text).toContain('SW-E022');
    // 迁移说明：注册表模板将 issues 数组以「、」连接渲染在单一「原因」行，
    // 断言意图不变（每条 issue 都必须展示给用户），从「每条一行」迁为「逐条包含」。
    for (const issue of issues) {
      expect(text).toContain(issue);
    }
    expect(lines.some((line) => line.includes('原因'))).toBe(true);
  });

  it('invalid-yaml → SW-E021 + 附解析细节', () => {
    const text = renderFailure({
      ok: false,
      reason: 'invalid-yaml',
      detail: 'Unexpected end of flow sequence',
    }).join('\n');
    expect(text).toContain('SW-E021');
    expect(text).toContain('YAML');
    expect(text).toContain('Unexpected end of flow sequence');
  });
});
