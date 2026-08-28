/**
 * `sw revise` 应用层验收（SPEC-04 验收 ①–④ 的引擎级断言 + W3 规格 §6 增补）。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject, loadProject } from '../../src/app/workflow/engine.js';
import { runDraftScene } from '../../src/app/workflow/draft.js';
import { runRevise, sceneTitle } from '../../src/app/workflow/revise.js';
import { renderReviseReport } from '../../src/app/workflow/reviseReport.js';
import { isSwError } from '../../src/app/errors/registry.js';
import { PROJECT_FILE } from '../../src/infra/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-revise-'));
  const result = await initProject(dir, { title: '我的短片', created: '2026-08-27' });
  expect(result.ok).toBe(true);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function expectFail(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect.unreachable('应抛 SwError');
  } catch (error) {
    expect(isSwError(error)).toBe(true);
    if (isSwError(error)) {
      expect(error.code).toBe(code);
    }
  }
}

async function projectYaml(): Promise<string> {
  return readFile(join(dir, PROJECT_FILE), 'utf8');
}

describe('app/workflow/revise：清单与建议（SPEC-04 无参数路径）', () => {
  it('空 scenes/ → ES-07 空态三要素、零写盘、步骤不推进', async () => {
    const before = await projectYaml();
    const outcome = await runRevise(dir);
    expect(outcome.action).toBe('empty');
    const text = renderReviseReport(outcome).join('\n');
    // ES-07 空态三要素（渲染层模板：what / 示例 / 下一步命令）
    expect(text).toContain('修订步针对既有场文件');
    expect(text).toContain('示例');
    expect(text).toContain('sw draft 010 --title "开场"');
    expect(await projectYaml()).toBe(before); // 空态零写盘
  });

  it('无参数 → 清单（id/状态/标题）+ 首未修订场建议 + 步骤补齐 revise', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    await runDraftScene(dir, '020', { title: '冲突' });
    const outcome = await runRevise(dir);
    expect(outcome.action).toBe('listed');
    expect(outcome.entries.map((e) => [e.id, e.revised])).toEqual([
      ['010', false],
      ['020', false],
    ]);
    expect(outcome.entries[0]?.title).toContain('场 010：开场');
    expect(outcome.nextCommand).toBe('sw revise 010');
    const lines = renderReviseReport(outcome);
    expect(lines[lines.length - 1]).toBe('sw revise 010');
    const loaded = await loadProject(dir);
    expect(loaded.ok && loaded.meta.progress.step).toBe('revise');
  });

  it('--list 纯只读：与无参数同清单但 project.yaml 字节不变（§6.4 零写盘断言）', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const before = await projectYaml();
    const outcome = await runRevise(dir, undefined, { list: true });
    expect(outcome.action).toBe('listed');
    expect(await projectYaml()).toBe(before);
  });

  it('全部已修订 → 建议 sw export（scenes_revised ⊇ scenes_done）', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    await runRevise(dir, '010', { done: true });
    const outcome = await runRevise(dir, undefined, { list: true });
    expect(outcome.nextCommand).toBe('sw export');
  });
});

describe('app/workflow/revise：打开与 --done（SPEC-04 §6.1/6.2）', () => {
  it('打开既有场：报告路径与引导，末行 sw revise <id> --done；不创建场', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const outcome = await runRevise(dir, '010');
    expect(outcome.action).toBe('opened');
    expect(outcome.fileName).toBe('010-开场.md');
    const lines = renderReviseReport(outcome);
    expect(lines.join('\n')).toContain('scenes/010-开场.md');
    expect(lines[lines.length - 1]).toBe('sw revise 010 --done');
  });

  it('id 不存在 → SW-E030 附现有 id 清单（复用注册表既有码，零新码）', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    await expectFail('SW-E030', () => runRevise(dir, '099'));
    await expectFail('SW-E030', () => runRevise(dir, '099', { done: true }));
  });

  it('非法编号形态 → SW-E032（与 draft 同归一规则）', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    await expectFail('SW-E032', () => runRevise(dir, 'abc'));
  });

  it('--done 幂等（SPEC-04 验收 ②）：重复标记 project.yaml 字节不变', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const first = await runRevise(dir, '010', { done: true });
    expect(first.action).toBe('done');
    // 回归锁：标记最后一场后建议命令按更新后的修订集重算（全修订 → sw export）
    expect(first.nextCommand).toBe('sw export');
    const yaml1 = await projectYaml();
    expect(yaml1).toContain('scenes_revised');
    expect(yaml1).toContain('010');
    await runRevise(dir, '010', { done: true });
    expect(await projectYaml()).toBe(yaml1);
    const loaded = await loadProject(dir);
    expect(loaded.ok && loaded.meta.progress.scenesRevised).toEqual(['010']);
  });

  it('10 ≡ 010 归一（与 draft 同规则）', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const outcome = await runRevise(dir, '10', { done: true });
    expect(outcome.sceneId).toBe('010');
  });
});

describe('app/workflow/revise：sceneTitle 轻量解析（§6.4 取数面）', () => {
  it('首行 `# ` 标题解析；无标题行原样返回', () => {
    expect(sceneTitle('# 场 010：开场\n\n正文')).toBe('场 010：开场');
    expect(sceneTitle('正文无标题')).toBe('正文无标题');
  });
});
