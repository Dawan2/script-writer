/**
 * `sw export` 应用层验收（SPEC-06 §5.4 ①–⑨ 的引擎级断言；进程级三档冒烟在 smoke:exit-codes）。
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initProject, loadProject } from '../../src/app/workflow/engine.js';
import { runDraftScene } from '../../src/app/workflow/draft.js';
import { normalizeExportFormat, runExport } from '../../src/app/workflow/export.js';
import { renderExportReport } from '../../src/app/workflow/exportReport.js';
import { renderMarkdownExport } from '../../src/app/workflow/exportRender.js';
import { isSwError } from '../../src/app/errors/registry.js';
import { writeOutlineFile } from '../../src/infra/store/outlineFile.js';
import { writeProjectFile } from '../../src/infra/store/projectFile.js';
import { EXPORTS_DIR, PROJECT_FILE } from '../../src/infra/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-export-'));
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

const defaultOut = (): string => join(dir, EXPORTS_DIR, '我的短片.md');

describe('app/workflow/export：聚合与确定性（§5.4-①②⑦）', () => {
  it('① outline + 两场 → 产物含大纲节与场景节、场序升序', async () => {
    await writeOutlineFile(dir, '# 大纲\n010 开场\n020 冲突\n');
    await runDraftScene(dir, '020', { title: '冲突' });
    await runDraftScene(dir, '010', { title: '开场' });
    const outcome = await runExport(dir);
    expect(outcome.outlineIncluded).toBe(true);
    const content = await readFile(defaultOut(), 'utf8');
    expect(content).toContain('# 我的短片');
    expect(content).toContain('## 大纲');
    expect(content).toContain('010 开场');
    expect(content).toContain('## 场景');
    expect(content.indexOf('# 场 010')).toBeLessThan(content.indexOf('# 场 020'));
    expect(content).toContain('\n---\n');
  });

  it('② 同输入重复导出字节级相同；已在 export 步时 project.yaml 不变（⑨）', async () => {
    await writeOutlineFile(dir, '# 大纲\n010 开场\n');
    await runDraftScene(dir, '010', { title: '开场' });
    await runExport(dir);
    const first = await readFile(defaultOut(), 'utf8');
    const yamlBefore = await readFile(join(dir, PROJECT_FILE), 'utf8');
    expect(yamlBefore).toContain('step: export'); // ⑨ 前半：从 draft 进入 export
    await runExport(dir);
    expect(await readFile(defaultOut(), 'utf8')).toBe(first);
    expect(await readFile(join(dir, PROJECT_FILE), 'utf8')).toBe(yamlBefore); // ⑨ 后半
  });

  it('⑦ outline 缺失但有场 → 大纲节省略、导出成功', async () => {
    await runDraftScene(dir, '010', { title: '开场' }); // D3 会补 outline，这里删掉模拟缺失
    await rm(join(dir, 'outline.md'));
    const outcome = await runExport(dir);
    expect(outcome.outlineIncluded).toBe(false);
    const content = await readFile(defaultOut(), 'utf8');
    expect(content).not.toContain('## 大纲');
    expect(content).toContain('## 场景');
  });

  it('大纲全空白视同缺失（§5.2-2 空节判定）', async () => {
    await writeOutlineFile(dir, '   \n\n');
    await runDraftScene(dir, '010', { title: '开场' });
    // draft 的 D3 会补骨架——先建场再刷白大纲
    await writeOutlineFile(dir, '  \n');
    const outcome = await runExport(dir);
    expect(outcome.outlineIncluded).toBe(false);
  });
});

describe('app/workflow/export：格式面与错误（§5.4-③④⑤）', () => {
  it('③ md ≡ markdown；fountain → SW-E033、零产物', async () => {
    expect(normalizeExportFormat('md')).toBe('markdown');
    expect(normalizeExportFormat('markdown')).toBe('markdown');
    await writeOutlineFile(dir, '# 大纲\n010 开场\n');
    await expectFail('SW-E033', () => runExport(dir, { format: 'fountain' }));
    expect(await readdir(join(dir, EXPORTS_DIR))).toEqual([]);
  });

  it('④ 空项目（无大纲无场）→ SW-E034、exports/ 无新文件', async () => {
    await expectFail('SW-E034', () => runExport(dir));
    expect(await readdir(join(dir, EXPORTS_DIR))).toEqual([]);
  });

  it('⑤ settings.export.default 被改为 fountain → 缺省导出报 SW-E033', async () => {
    const loaded = await loadProject(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    await writeProjectFile(dir, {
      ...loaded.meta,
      settings: { ...loaded.meta.settings, export: { default: 'fountain' } },
    });
    await writeOutlineFile(dir, '# 大纲\n010 开场\n');
    await expectFail('SW-E033', () => runExport(dir));
    // 显式 --format markdown 覆盖坏默认值可正常导出
    const outcome = await runExport(dir, { format: 'markdown' });
    expect(outcome.outlineIncluded).toBe(true);
  });
});

describe('app/workflow/export：产物路径与报告（§5.4-⑥⑧）', () => {
  it('⑥ --out 指定路径（含不存在的父目录）写入成功', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const out = join(dir, 'dist', 'final.md');
    const outcome = await runExport(dir, { out });
    expect(outcome.outPath).toBe(out);
    expect(await readFile(out, 'utf8')).toContain('# 场 010');
  });

  it('⑧ 未标完成场存在时导出成功且报告含完成度提示行', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    await runDraftScene(dir, '020', { title: '冲突' });
    await runDraftScene(dir, '010', { done: true });
    const outcome = await runExport(dir);
    expect(outcome.sceneCount).toBe(2);
    expect(outcome.doneCount).toBe(1);
    const text = renderExportReport(outcome).join('\n');
    expect(text).toContain('导出 2 场（已标记完成 1/2）');
    expect(text).toContain('场 020 尚未标记完成');
    expect(text).toContain('sw draft 020 --done');
    const lines = text.split('\n');
    expect(lines[lines.length - 1]).toBe('sw status'); // 链尾末行
  });

  it('全部场已标完成时报告无提示行', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    await runDraftScene(dir, '010', { done: true });
    const outcome = await runExport(dir);
    expect(outcome.unfinishedIds).toEqual([]);
    expect(renderExportReport(outcome).join('\n')).not.toContain('尚未标记完成');
  });
});

describe('app/workflow/exportRender：纯函数出口（零 IO、无时间戳）', () => {
  it('双空以外的最小输入产出确定性文本，同输入字节级相同', () => {
    const input = {
      title: 'T',
      format: 'short-video',
      created: '2026-08-27',
      outlineText: null,
      scenes: [{ fileName: '010-a.md', content: '# 场 010\n正文\n\n' }],
    };
    const a = renderMarkdownExport(input);
    const b = renderMarkdownExport(input);
    expect(a).toBe(b);
    expect(a).toContain('> script-writer 导出 · 格式 markdown v1 · format: short-video · created: 2026-08-27');
    expect(a).not.toContain('## 大纲');
    expect(a.endsWith('正文\n')).toBe(true); // 场原文尾部空白归一
  });
});
