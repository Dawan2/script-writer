/**
 * 应用层·`sw revise` 修订步命令（SPEC-04 原文 + W3 规格 §6 对齐增补，W2-GAP-T01）。
 * 打开语义对齐 SPEC-02 `sw outline`：确保文件就位 + 报告路径与引导，不启动编辑器；
 * **revise 不创建场**（创建属 draft 职责，步骤边界不重叠）。
 * `scenes_revised` 完成判定按 id 集合比较：scenes_revised ⊇ scenes_done → 建议 export。
 * --list 纯只读：不写盘、不加锁、输出稳定可供脚本消费（§6.4）。
 */

import {
  ensureStepAtLeast,
  recordSceneRevised,
  sceneCompletion,
} from '../../core/model/progress.js';
import { findSceneFileById, normalizeSceneId, readSceneFiles } from '../../infra/store/sceneFile.js';
import { scanProjectDisk } from '../../infra/store/projectFile.js';
import { fail } from '../errors/registry.js';
import { loadProject, saveProject, type ProjectStatus } from './engine.js';
import { failProject } from './statusReport.js';

export interface ReviseOptions {
  /** 把该场标记为已修订（幂等，记入 progress.scenes_revised）。 */
  done?: boolean;
  /** 纯只读清单（不写任何文件）。 */
  list?: boolean;
}

/** 修订清单条目（§6.4：标题来源 = 场文件首行 `# ` 标题的轻量解析）。 */
export interface ReviseEntry {
  id: string;
  title: string;
  revised: boolean;
}

export interface ReviseOutcome {
  /** empty = 空 scenes/（空态三要素）；listed = 清单；opened = 打开场；done = 标记已修订。 */
  action: 'empty' | 'listed' | 'opened' | 'done';
  sceneId?: string;
  fileName?: string;
  entries: readonly ReviseEntry[];
  /** 清单/打开路径的建议命令（首未修订场 `sw revise <id>`；全修订 → `sw export`）。 */
  nextCommand: string;
  status: ProjectStatus;
}

/** 场文件首行 `# ` 标题轻量解析（不引入 P4 T01 内容索引层依赖）。 */
export function sceneTitle(content: string): string {
  const first = content.split('\n', 1)[0]?.trim() ?? '';
  return first.startsWith('# ') ? first.slice(2).trim() : first;
}

async function toStatus(projectDir: string, meta: ProjectStatus['meta']): Promise<ProjectStatus> {
  const disk = await scanProjectDisk(projectDir);
  return { meta, disk, scenes: sceneCompletion(meta.progress, disk, meta.expectedSceneCount) };
}

/** `sw revise` 的引擎入口。 */
export async function runRevise(
  projectDir: string,
  rawSceneId?: string,
  options: ReviseOptions = {},
): Promise<ReviseOutcome> {
  const loaded = await loadProject(projectDir);
  if (!loaded.ok) {
    failProject(loaded, projectDir);
  }
  let meta = loaded.meta;
  const disk = await scanProjectDisk(projectDir);

  // 空态：scenes/ 为空 → 空态三要素（ES-07），不推进步骤、零写盘
  if (disk.sceneIds.length === 0) {
    return {
      action: 'empty',
      entries: [],
      nextCommand: '',
      status: await toStatus(projectDir, meta),
    };
  }

  const revisedSet = new Set(meta.progress.scenesRevised);
  const buildEntries = async (): Promise<ReviseEntry[]> => {
    const sceneFiles = await readSceneFiles(projectDir);
    return sceneFiles.map(({ fileName, content }) => {
      const id = /^(\d{3,})-.*\.md$/.exec(fileName)?.[1] ?? fileName;
      return { id, title: sceneTitle(content), revised: revisedSet.has(id) };
    });
  };
  const suggestNext = (entries: readonly ReviseEntry[]): string => {
    const firstUnrevised = entries.find((entry) => !entry.revised);
    return firstUnrevised === undefined ? 'sw export' : `sw revise ${firstUnrevised.id}`;
  };
  const entries = await buildEntries();
  const nextCommand = suggestNext(entries);

  // --done 路径：场存在性防线（防 scenes_revised 与磁盘漂移）→ 幂等记录 + 步骤补齐
  if (rawSceneId !== undefined && options.done === true) {
    const sceneId = normalizeSceneId(rawSceneId);
    if (sceneId === null) {
      fail('SW-E032', { sceneId: rawSceneId, existingIds: disk.sceneIds });
    }
    const existing = await findSceneFileById(projectDir, sceneId);
    if (existing === undefined) {
      fail('SW-E030', { sceneId, existingIds: disk.sceneIds });
    }
    const progress = ensureStepAtLeast(recordSceneRevised(meta.progress, sceneId), 'revise');
    if (progress !== meta.progress) {
      meta = { ...meta, progress };
      await saveProject(projectDir, meta);
    }
    // 建议命令按更新后的修订集重算（全修订 → sw export）
    const updatedSet = new Set(meta.progress.scenesRevised);
    const updatedEntries = entries.map((entry) => ({
      ...entry,
      revised: updatedSet.has(entry.id),
    }));
    return {
      action: 'done',
      sceneId,
      fileName: existing,
      entries: updatedEntries,
      nextCommand: suggestNext(updatedEntries),
      status: await toStatus(projectDir, meta),
    };
  }

  // 打开路径：校验场存在（否则 SW-E030 附现有 id 清单）→ 步骤补齐 → 报告
  if (rawSceneId !== undefined) {
    const sceneId = normalizeSceneId(rawSceneId);
    if (sceneId === null) {
      fail('SW-E032', { sceneId: rawSceneId, existingIds: disk.sceneIds });
    }
    const existing = await findSceneFileById(projectDir, sceneId);
    if (existing === undefined) {
      fail('SW-E030', { sceneId, existingIds: disk.sceneIds });
    }
    const progress = ensureStepAtLeast(meta.progress, 'revise');
    if (progress !== meta.progress) {
      meta = { ...meta, progress };
      await saveProject(projectDir, meta);
    }
    return {
      action: 'opened',
      sceneId,
      fileName: existing,
      entries,
      nextCommand: `sw revise ${sceneId} --done`,
      status: await toStatus(projectDir, meta),
    };
  }

  // 清单路径：--list 纯只读零写盘；无参数裸 revise 把步骤补齐到 revise（§3-3 锁矩阵写路径）
  if (options.list !== true) {
    const progress = ensureStepAtLeast(meta.progress, 'revise');
    if (progress !== meta.progress) {
      meta = { ...meta, progress };
      await saveProject(projectDir, meta);
    }
  }
  return {
    action: 'listed',
    entries,
    nextCommand,
    status: await toStatus(projectDir, meta),
  };
}
