/**
 * 应用层·`sw export` 导出命令（SPEC-06，W3-DRAFT-T02）：markdown v1。
 * 数据源 = 磁盘现状（outline.md + scenes/*.md），不是 scenes_done——导出所见即所得，
 * 未标完成的场也导出（可跳过语义），报告提示完成度。
 * 格式面按 ADR-0001 §3.6：v1 只支持 markdown（md 为归一别名），其余值 fail SW-E033；
 * 双空（无大纲且无场）fail SW-E034 零产物落盘。派生产物允许覆盖（§5.2-5）。
 */

import { resolve, join } from 'node:path';
import { ensureStepAtLeast, sceneCompletion } from '../../core/model/progress.js';
import { readOutlineText } from '../../infra/store/outlineFile.js';
import { readSceneFiles } from '../../infra/store/sceneFile.js';
import { writeExportFile } from '../../infra/store/exportFile.js';
import { scanProjectDisk } from '../../infra/store/projectFile.js';
import { EXPORTS_DIR } from '../../infra/store/layout.js';
import { fail } from '../errors/registry.js';
import { loadProject, saveProject, type ProjectStatus } from './engine.js';
import { sceneSlug } from './draft.js';
import { renderMarkdownExport } from './exportRender.js';
import { failProject } from './statusReport.js';

export interface ExportOptions {
  /** 导出格式；缺省取 settings.export.default（md 归一为 markdown）。 */
  format?: string;
  /** 产物文件路径（非目录）；缺省 exports/<slug(title)>.md。 */
  out?: string;
}

export interface ExportOutcome {
  /** 产物绝对路径。 */
  outPath: string;
  /** 聚合进产物的场数（磁盘口径）。 */
  sceneCount: number;
  /** 已标记完成的场数（scenes_done 口径，报告完成度用）。 */
  doneCount: number;
  /** 磁盘存在但未标完成的场编号（报告提示行用，不阻塞导出）。 */
  unfinishedIds: readonly string[];
  /** 产物是否含大纲节。 */
  outlineIncluded: boolean;
  status: ProjectStatus;
}

/** 格式归一与校验（§5.1）：md ≡ markdown；其余 → SW-E033。 */
export function normalizeExportFormat(raw: string): string {
  const format = raw === 'md' ? 'markdown' : raw;
  if (format !== 'markdown') {
    fail('SW-E033', { format: raw });
  }
  return format;
}

/** `sw export` 的引擎入口。 */
export async function runExport(
  projectDir: string,
  options: ExportOptions = {},
): Promise<ExportOutcome> {
  const loaded = await loadProject(projectDir);
  if (!loaded.ok) {
    failProject(loaded, projectDir);
  }
  let meta = loaded.meta;
  // §5.1：--format 缺省取 settings.export.default；该字段被改成不支持的值同走 E033。
  normalizeExportFormat(options.format ?? meta.settings.export.default);

  // §5.2：聚合数据源 = 磁盘现状；空节省略，双空 → SW-E034 零产物。
  const outlineRaw = await readOutlineText(projectDir);
  const outlineText = outlineRaw !== null && outlineRaw.trim().length > 0 ? outlineRaw.trim() : null;
  const scenes = await readSceneFiles(projectDir);
  if (outlineText === null && scenes.length === 0) {
    fail('SW-E034', {});
  }

  const content = renderMarkdownExport({
    title: meta.title,
    format: meta.format,
    created: meta.created,
    outlineText,
    scenes,
  });
  const outPath =
    options.out !== undefined
      ? resolve(options.out)
      : join(projectDir, EXPORTS_DIR, `${sceneSlug(meta.title)}.md`);
  await writeExportFile(outPath, content);

  // §5.3：成功后步骤补齐到 export（已在 export 步则无变化不写盘）。
  const progress = ensureStepAtLeast(meta.progress, 'export');
  if (progress !== meta.progress) {
    meta = { ...meta, progress };
    await saveProject(projectDir, meta);
  }
  const disk = await scanProjectDisk(projectDir);
  const done = new Set(meta.progress.scenesDone);
  return {
    outPath,
    sceneCount: scenes.length,
    doneCount: meta.progress.scenesDone.length,
    unfinishedIds: disk.sceneIds.filter((id) => !done.has(id)),
    outlineIncluded: outlineText !== null,
    status: { meta, disk, scenes: sceneCompletion(meta.progress, disk, meta.expectedSceneCount) },
  };
}
