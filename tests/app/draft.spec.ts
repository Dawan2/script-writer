/**
 * `sw draft` 应用层验收（SPEC-05 §4.5 ①–⑨ 的引擎级断言；进程级三档冒烟在 smoke:exit-codes）。
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject, loadProject } from '../../src/app/workflow/engine.js';
import { runDraftScene, sceneSlug } from '../../src/app/workflow/draft.js';
import { renderDraftReport } from '../../src/app/workflow/draftReport.js';
import { isSwError } from '../../src/app/errors/registry.js';
import { OUTLINE_FILE, PROJECT_FILE, SCENES_DIR } from '../../src/infra/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-draft-'));
  const result = await initProject(dir, { title: '我的短片', created: '2026-08-27' });
  expect(result.ok).toBe(true);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function projectYaml(): Promise<string> {
  return readFile(join(dir, PROJECT_FILE), 'utf8');
}

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

describe('app/workflow/draft：D1 创建（SPEC-05 §4.5-①）', () => {
  it('空 scenes/ 下 draft 010 --title "开场" 产出骨架、步骤 ≥ draft、末行逐字 sw draft 010 --done', async () => {
    const outcome = await runDraftScene(dir, '010', { title: '开场' });
    expect(outcome.action).toBe('created');
    expect(outcome.fileName).toBe('010-开场.md');
    const content = await readFile(join(dir, SCENES_DIR, outcome.fileName), 'utf8');
    expect(content).toContain('# 场 010：开场');
    for (const marker of ['这里是什么', '示例长什么样', 'sw draft 010 --done']) {
      expect(content).toContain(marker);
    }
    const loaded = await loadProject(dir);
    expect(loaded.ok && loaded.meta.progress.step).toBe('draft');
    const lines = renderDraftReport(outcome);
    expect(lines[lines.length - 1]).toBe('sw draft 010 --done');
  });

  it('缺省标题 = 场 <id>（status 建议命令可直接粘贴执行）；slug 空回退 scene', async () => {
    const outcome = await runDraftScene(dir, '020');
    expect(outcome.fileName).toBe('020-scene.md');
    const content = await readFile(join(dir, SCENES_DIR, outcome.fileName), 'utf8');
    expect(content).toContain('# 场 020：场 020');
    expect(sceneSlug(undefined)).toBe('scene');
    expect(sceneSlug('  ')).toBe('scene');
    expect(sceneSlug('Rainy Night')).toBe('rainy-night');
  });
});

describe('app/workflow/draft：D2 幂等保留（§4.5-②）', () => {
  it('重复执行：场文件与 project.yaml 字节不变，报告 kept', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const fileBefore = await readFile(join(dir, SCENES_DIR, '010-开场.md'), 'utf8');
    const yamlBefore = await projectYaml();
    const outcome = await runDraftScene(dir, '010', { title: '开场' });
    expect(outcome.action).toBe('kept');
    expect(await readFile(join(dir, SCENES_DIR, '010-开场.md'), 'utf8')).toBe(fileBefore);
    expect(await projectYaml()).toBe(yamlBefore);
  });

  it('kept 路径给 --title 不改名并在报告中说明未消费（按编号判定不看 slug）', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const outcome = await runDraftScene(dir, '010', { title: '改名' });
    expect(outcome.action).toBe('kept');
    expect(outcome.titleIgnored).toBe(true);
    expect(outcome.fileName).toBe('010-开场.md');
    expect(renderDraftReport(outcome).join('\n')).toContain('--title 未消费');
  });
});

describe('app/workflow/draft：D3 自动补大纲（§4.5-⑤，MP-05）', () => {
  it('outline.md 缺失时 draft 先补骨架再创建场，报告含「已补大纲骨架」且 outline 无占位残留', async () => {
    await rm(join(dir, OUTLINE_FILE), { force: true });
    const outcome = await runDraftScene(dir, '010', { title: '开场' });
    expect(outcome.outlineFilled).toBe(true);
    expect(renderDraftReport(outcome).join('\n')).toContain('补齐大纲骨架');
    const outline = await readFile(join(dir, OUTLINE_FILE), 'utf8');
    expect(outline).toContain('我的短片');
    expect(outline).not.toContain('{{');
  });
});

describe('app/workflow/draft：D4/D5 --done（§4.5-③④）', () => {
  it('--done 后 scenes_done 含该 id；重复 --done 后 project.yaml 字节不变（幂等）', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const done = await runDraftScene(dir, '010', { done: true });
    expect(done.action).toBe('done');
    let loaded = await loadProject(dir);
    expect(loaded.ok && loaded.meta.progress.scenesDone).toEqual(['010']);
    const yamlBefore = await projectYaml();
    await runDraftScene(dir, '010', { done: true });
    expect(await projectYaml()).toBe(yamlBefore);
    loaded = await loadProject(dir);
    expect(loaded.ok && loaded.meta.progress.scenesDone).toEqual(['010']);
  });

  it('--done 且磁盘无该场 → SW-E030，零写盘副作用（目录快照对比）', async () => {
    const before = await readdir(dir);
    const yamlBefore = await projectYaml();
    await expectFail('SW-E030', () => runDraftScene(dir, '010', { done: true }));
    expect(await readdir(dir)).toEqual(before);
    expect(await projectYaml()).toBe(yamlBefore);
  });
});

describe('app/workflow/draft：D6/D7 错误面', () => {
  it('非法编号 → SW-E032（附现有 id 清单），零写盘', async () => {
    const before = await readdir(join(dir, SCENES_DIR));
    await expectFail('SW-E032', () => runDraftScene(dir, 'abc'));
    expect(await readdir(join(dir, SCENES_DIR))).toEqual(before);
  });

  it('非项目目录 → SW-E011', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'sw-draft-np-'));
    try {
      await expectFail('SW-E011', () => runDraftScene(empty, '010'));
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('app/workflow/draft：编号归一等价（§4.5-⑨）', () => {
  it('sw draft 10 与 sw draft 010 行为等价（同一场文件）', async () => {
    await runDraftScene(dir, '10', { title: '开场' });
    expect(await readdir(join(dir, SCENES_DIR))).toEqual(['010-开场.md']);
    const outcome = await runDraftScene(dir, '010', { done: true });
    expect(outcome.action).toBe('done');
  });
});

describe('app/workflow/draft：--done 路径的 status 联动（§4.4 末行规则）', () => {
  it('标记完成后末行指向下一步（下一场 / export）', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    await runDraftScene(dir, '020', { title: '冲突' });
    const done = await runDraftScene(dir, '010', { done: true });
    const lines = renderDraftReport(done);
    expect(lines[lines.length - 1]).toBe('sw draft 020 --done');
  });
});
