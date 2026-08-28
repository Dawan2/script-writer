import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initProject,
  loadProject,
  markSceneDone,
  readStatus,
  saveProject,
} from '../../src/app/workflow/engine.js';
import { sceneFileName, PROJECT_FILE } from '../../src/infra/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-engine-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function initFixture() {
  const result = await initProject(dir, { title: '我的短片', created: '2026-08-27' });
  expect(result.ok).toBe(true);
  return result;
}

describe('app/workflow/engine：init 挂钩', () => {
  it('initProject 产出 v1 状态源与标准子目录（scenes/characters/exports）', async () => {
    await initFixture();
    expect((await stat(join(dir, PROJECT_FILE))).isFile()).toBe(true);
    for (const sub of ['scenes', 'characters', 'exports']) {
      expect((await stat(join(dir, sub))).isDirectory()).toBe(true);
    }
    const loaded = await loadProject(dir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.meta.title).toBe('我的短片');
      expect(loaded.meta.progress).toEqual({ step: 'outline', scenesDone: [], scenesRevised: [] });
    }
  });

  it('重复 init 报错且不破坏现场（SPEC-01 幂等约束）', async () => {
    await initFixture();
    const before = await readFile(join(dir, PROJECT_FILE), 'utf8');
    const again = await initProject(dir, { title: '另一个标题' });
    expect(again).toEqual({ ok: false, reason: 'already-a-project' });
    expect(await readFile(join(dir, PROJECT_FILE), 'utf8')).toBe(before);
  });
});

describe('app/workflow/engine：读取与校验（SPEC-02 数据流 ①）', () => {
  it('非项目目录 → not-a-project（SW-E011 语义）', async () => {
    expect(await loadProject(dir)).toEqual({ ok: false, reason: 'not-a-project' });
  });

  it('project.yaml 损坏 → invalid-yaml，附解析细节', async () => {
    await writeFile(join(dir, PROJECT_FILE), 'schema: [1');
    const loaded = await loadProject(dir);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toBe('invalid-yaml');
  });

  it('schema 版本超前 → schema-incompatible（SW-E020 语义 + 迁移指引数据）', async () => {
    await writeFile(join(dir, PROJECT_FILE), 'schema: 2\ntitle: x\n');
    const loaded = await loadProject(dir);
    expect(loaded).toEqual({ ok: false, reason: 'schema-incompatible', found: 2, expected: 1 });
  });

  it('字段畸形 → malformed，issues 可直接渲染', async () => {
    await writeFile(join(dir, PROJECT_FILE), 'schema: 1\ntitle: ""\n');
    const loaded = await loadProject(dir);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok && loaded.reason === 'malformed') {
      expect(loaded.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('app/workflow/engine：状态回写与恢复（SPEC-02 数据流 ③④）', () => {
  it('markSceneDone 原子写回：进度落盘、重新加载一致（中断恢复语义）', async () => {
    await initFixture();
    const marked = await markSceneDone(dir, '010');
    expect(marked.ok).toBe(true);
    // 模拟"进程结束后重来"：全新读取磁盘状态
    const reloaded = await loadProject(dir);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.meta.progress.scenesDone).toEqual(['010']);
      expect(reloaded.meta.progress.step).toBe('draft'); // 可跳过：outline 自动补齐到 draft
    }
  });

  it('markSceneDone 幂等：重复标记不改文件（mtime 级别不比较，比内容）', async () => {
    await initFixture();
    await markSceneDone(dir, '010');
    const before = await readFile(join(dir, PROJECT_FILE), 'utf8');
    const again = await markSceneDone(dir, '010');
    expect(again.ok).toBe(true);
    expect(await readFile(join(dir, PROJECT_FILE), 'utf8')).toBe(before);
  });

  it('markSceneDone 在非项目目录失败且不产生文件', async () => {
    const result = await markSceneDone(dir, '010');
    expect(result).toEqual({ ok: false, reason: 'not-a-project' });
    expect((await readdir(dir)).length).toBe(0);
  });

  it('回写后项目目录不留 .tmp 残骸（原子事务收尾）', async () => {
    await initFixture();
    await markSceneDone(dir, '010');
    await markSceneDone(dir, '020');
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('saveProject 支持任意合法状态推进（供 outline/export 命令落地复用）', async () => {
    const init = await initFixture();
    if (!init.ok) return;
    await saveProject(dir, {
      ...init.meta,
      progress: { step: 'export', scenesDone: ['010'], scenesRevised: [] },
    });
    const reloaded = await loadProject(dir);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.meta.progress.step).toBe('export');
  });
});

describe('app/workflow/engine：引擎级端到端（init → draft 记录 → status 恢复）', () => {
  it('全链路状态一致：磁盘场文件、scenes_done 与 status 汇总互相印证', async () => {
    await initFixture();
    // 模拟 sw draft 落盘两场（场文件写入属 draft 命令职责，此处直接按布局约定写）
    await writeFile(join(dir, 'scenes', sceneFileName(10, 'opening')), '# 开场');
    await writeFile(join(dir, 'scenes', sceneFileName(20, 'chase')), '# 追逐');
    await markSceneDone(dir, '010');

    const status = await readStatus(dir);
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.status.meta.title).toBe('我的短片');
      expect(status.status.meta.progress.step).toBe('draft');
      expect(status.status.disk.sceneIds).toEqual(['010', '020']);
      expect(status.status.scenes).toEqual({ done: 1, total: 2 });
    }
  });

  it('readStatus 对非项目目录返回 not-a-project（恢复入口的失败分支）', async () => {
    expect(await readStatus(dir)).toEqual({ ok: false, reason: 'not-a-project' });
  });
});
