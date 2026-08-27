import { describe, expect, it } from 'vitest';
import { createProjectMeta, type ProjectMeta } from '../../src/core/model/project.js';
import type { WorkflowStep } from '../../src/core/model/workflow.js';
import type { ProjectStatus } from '../../src/app/workflow/engine.js';
import {
  FIRST_SCENE_COMMAND,
  nextActionCommand,
  renderProjectFailure,
  renderStatusReport,
  suggestNextSceneId,
} from '../../src/app/workflow/statusReport.js';

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

  it('draft 已有场景时按步长 10 推算下一场编号', () => {
    expect(nextActionCommand(statusOf('draft', ['010'], ['010', '020']))).toBe('sw draft 030');
    expect(suggestNextSceneId([])).toBe('010');
    expect(suggestNextSceneId(['010', '020'])).toBe('030');
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

describe('app/workflow/statusReport：失败态三段式（SPEC-03 消息模板，待 T06 框架接管）', () => {
  it('not-a-project → SW-E011 + 原因 + 怎么办', () => {
    const text = renderProjectFailure({ ok: false, reason: 'not-a-project' }).join('\n');
    expect(text).toContain('SW-E011');
    expect(text).toContain('原因');
    expect(text).toContain('怎么办');
    expect(text).toContain('sw init');
  });

  it('schema-incompatible → SW-E020 + 双方版本', () => {
    const text = renderProjectFailure({
      ok: false,
      reason: 'schema-incompatible',
      found: 2,
      expected: 1,
    }).join('\n');
    expect(text).toContain('SW-E020');
    expect(text).toContain('schema: 2');
    expect(text).toContain('schema: 1');
  });

  it('malformed → 每条 issue 一行原因', () => {
    const lines = renderProjectFailure({
      ok: false,
      reason: 'malformed',
      issues: ['title 必须是非空字符串', 'progress.step 必须是 init|outline|draft|revise|export 之一'],
    });
    expect(lines.filter((line) => line.includes('原因')).length).toBe(2);
  });

  it('invalid-yaml → 附解析细节', () => {
    const text = renderProjectFailure({
      ok: false,
      reason: 'invalid-yaml',
      detail: 'Unexpected end of flow sequence',
    }).join('\n');
    expect(text).toContain('YAML');
    expect(text).toContain('Unexpected end of flow sequence');
  });
});
