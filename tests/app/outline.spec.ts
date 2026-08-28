import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCRIPT_FORMATS, type ScriptFormat } from '../../src/core/model/project.js';
import { initProject, loadProject, saveProject } from '../../src/app/workflow/engine.js';
import { ensureOutline, renderOutlineSkeleton } from '../../src/app/workflow/outline.js';
import { renderOutlineReport } from '../../src/app/workflow/outlineReport.js';
import { OUTLINE_FILE, PROJECT_FILE, sceneFileName } from '../../src/infra/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-outline-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function initFixture(format?: ScriptFormat) {
  const result = await initProject(dir, {
    title: '我的项目',
    created: '2026-08-27',
    ...(format === undefined ? {} : { format }),
  });
  expect(result.ok).toBe(true);
  return result;
}

describe('app/workflow/outline：空态写骨架（SPEC-02 "若为空写入模板骨架"）', () => {
  it.each([...SCRIPT_FORMATS])(
    '%s 项目：outline.md 缺失 → created，骨架含标题、无占位残留、含空态引导',
    async (format) => {
      await initFixture(format);
      const result = await ensureOutline(dir);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.action).toBe('created');

      const content = await readFile(join(dir, OUTLINE_FILE), 'utf8');
      expect(content).toContain('我的项目');
      expect(content).not.toContain('{{');
      for (const marker of ['这里是什么', '示例', '下一步']) {
        expect(content).toContain(marker);
      }
    },
  );

  it('预计场数缺省渲染为默认值 5（SPEC-01 默认）', async () => {
    await initFixture();
    await ensureOutline(dir);
    expect(await readFile(join(dir, OUTLINE_FILE), 'utf8')).toContain('预计 5 场');
  });

  it('project.yaml 带 expectedSceneCount 时按其值渲染', async () => {
    const init = await initFixture();
    if (!init.ok) return;
    await saveProject(dir, { ...init.meta, expectedSceneCount: 8 });
    await ensureOutline(dir);
    expect(await readFile(join(dir, OUTLINE_FILE), 'utf8')).toContain('预计 8 场');
  });

  it('outline.md 存在但全空白 → 视同为空，写入骨架（不算覆盖）', async () => {
    await initFixture();
    await writeFile(join(dir, OUTLINE_FILE), '  \n\n\t');
    const result = await ensureOutline(dir);
    expect(result.ok && result.action).toBe('created');
    expect(await readFile(join(dir, OUTLINE_FILE), 'utf8')).toContain('我的项目');
  });
});

describe('app/workflow/outline：幂等与状态回写（引擎数据流 ④）', () => {
  it('已有内容 → kept，文件字节级不动（幂等：只补缺、不覆盖）', async () => {
    await initFixture();
    const mine = '# 我手写的大纲\n010 开场\n';
    await writeFile(join(dir, OUTLINE_FILE), mine);
    const result = await ensureOutline(dir);
    expect(result.ok && result.action).toBe('kept');
    expect(await readFile(join(dir, OUTLINE_FILE), 'utf8')).toBe(mine);
  });

  it('连续两次运行：第二次 kept 且骨架不被重写', async () => {
    await initFixture();
    await ensureOutline(dir);
    const first = await readFile(join(dir, OUTLINE_FILE), 'utf8');
    const again = await ensureOutline(dir);
    expect(again.ok && again.action).toBe('kept');
    expect(await readFile(join(dir, OUTLINE_FILE), 'utf8')).toBe(first);
  });

  it('步骤补齐到 draft 并原子落盘（重新加载可见，恢复语义）', async () => {
    await initFixture();
    await ensureOutline(dir);
    const reloaded = await loadProject(dir);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.meta.progress.step).toBe('draft');
  });

  it('步骤只进不退：已在 export 步时不回退，且状态文件内容不变', async () => {
    const init = await initFixture();
    if (!init.ok) return;
    await saveProject(dir, {
      ...init.meta,
      progress: { step: 'export', scenesDone: ['010'], scenesRevised: [] },
    });
    const before = await readFile(join(dir, PROJECT_FILE), 'utf8');
    const result = await ensureOutline(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status.meta.progress.step).toBe('export');
    expect(await readFile(join(dir, PROJECT_FILE), 'utf8')).toBe(before);
  });

  it('回写不丢 GAP-03 字段：expectedSceneCount 在 outline 运行后仍在盘上', async () => {
    const init = await initFixture();
    if (!init.ok) return;
    await saveProject(dir, { ...init.meta, expectedSceneCount: 8 });
    await ensureOutline(dir); // 步骤补齐会触发一次状态回写
    expect(await readFile(join(dir, PROJECT_FILE), 'utf8')).toContain('expectedSceneCount: 8');
  });

  it('运行后项目目录不留 .tmp 残骸（原子事务收尾）', async () => {
    await initFixture();
    await ensureOutline(dir);
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('非项目目录 → not-a-project（SW-E011 语义），且不产生任何文件', async () => {
    const result = await ensureOutline(dir);
    expect(result).toEqual({ ok: false, reason: 'not-a-project' });
    expect((await readdir(dir)).length).toBe(0);
  });
});

describe('app/workflow/outline：渲染层（末行可复制命令，SPEC-02 验收要点）', () => {
  it('created：报告创建 + 引导 + 末行为第一场完整示例命令（scenes/ 空态三要素）', async () => {
    await initFixture();
    const result = await ensureOutline(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = renderOutlineReport(result);
    expect(lines.join('\n')).toContain('已创建 outline.md');
    const last = lines[lines.length - 1];
    expect(last).toBe('sw draft 010 --title "开场"');
  });

  it('kept：报告未改动，末行依磁盘现状推算下一场编号', async () => {
    await initFixture();
    await writeFile(join(dir, OUTLINE_FILE), '# 大纲\n010 开场\n');
    await writeFile(join(dir, 'scenes', sceneFileName(10, 'opening')), '# 开场');
    const result = await ensureOutline(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = renderOutlineReport(result);
    expect(lines.join('\n')).toContain('未改动');
    const last = lines[lines.length - 1];
    expect(last?.startsWith('sw ')).toBe(true);
    expect(last).not.toContain('<');
    // draft 落地后下一场推算细化：场 010 已存在但未完成，优先提示回写完成态
    expect(last).toBe('sw draft 010 --done');
  });
});

describe('app/workflow/outline：骨架渲染纯出口', () => {
  it('renderOutlineSkeleton 对三种 format 均产出非空文本且变量代入', async () => {
    for (const format of SCRIPT_FORMATS) {
      const text = await renderOutlineSkeleton({
        schema: 1,
        title: '标题X',
        format,
        created: '2026-08-27',
        settings: { ai: { enabled: false, provider: null }, export: { default: 'markdown' } },
        progress: { step: 'outline', scenesDone: [], scenesRevised: [] },
      });
      expect(text).toContain('标题X');
      expect(text).not.toContain('{{');
    }
  });
});
