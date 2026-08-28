/**
 * 应用层·`sw draft` 场景写作命令（SPEC-05，W3-DRAFT-T01）。
 * 行为矩阵 D1–D7（规格 §4.2）：创建骨架（原子写）/ 按编号幂等保留 / --done 显式标记完成；
 * outline 缺失或空白时先自动补骨架（D3，MP-05 跳步直达，复用 ensureOutline）。
 * 核心裁定（§4）：「完成」由用户显式声明（--done），创建场文件本身不算完成。
 *
 * 数据流与引擎各入口同构（engine.ts ①–⑤）；错误只经 fail()/failProject() 唯一入口，
 * 磁盘存在性防线（D5）放本层入口，不改引擎 markSceneDone 签名（规格 §4.4）。
 */

import { ensureStepAtLeast, sceneCompletion } from '../../core/model/progress.js';
import {
  findSceneFileById,
  normalizeSceneId,
  writeSceneFile,
} from '../../infra/store/sceneFile.js';
import { inspectOutlineFile } from '../../infra/store/outlineFile.js';
import { scanProjectDisk } from '../../infra/store/projectFile.js';
import { SCENES_DIR } from '../../infra/store/layout.js';
import { fail } from '../errors/registry.js';
import {
  loadProject,
  markSceneDone,
  saveProject,
  type ProjectStatus,
} from './engine.js';
import { ensureOutline } from './outline.js';
import { failProject } from './statusReport.js';

/** created = 新建场骨架；kept = 场已存在幂等保留；done = --done 标记完成。 */
export type DraftAction = 'created' | 'kept' | 'done';

export interface DraftOutcome {
  action: DraftAction;
  /** 归一后的 3 位场编号。 */
  sceneId: string;
  /** 场文件名（done 路径为既有文件）。 */
  fileName: string;
  /** 本次是否顺手补了大纲骨架（D3）。 */
  outlineFilled: boolean;
  /** --title 未被消费的提示（kept 路径给了 --title 时）。 */
  titleIgnored: boolean;
  status: ProjectStatus;
}

/** 标题 → 文件名 slug（§4.3：trim → lowercase → 空白转 `-`，中文原样通过；空回退 scene）。 */
export function sceneSlug(title: string | undefined): string {
  const normalized = (title ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return normalized.length === 0 ? 'scene' : normalized;
}

/**
 * 场文件骨架（§4.3：代码生成，不扩模板文件树；空态三要素内嵌为 Markdown 注释）。
 * 台词署名语法未定案（P4 T01 风险条款），示例保持中性文本。
 */
export function renderSceneSkeleton(sceneId: string, title: string, fileName: string): string {
  return `# 场 ${sceneId}：${title}

<!-- 这里是什么：第 ${sceneId} 场的正文（${SCENES_DIR}/${fileName}）。
     示例长什么样：
       （场景说明）雨夜，出租车内。
       张三：今天不该出门的。
     写完本场后敲：sw draft ${sceneId} --done -->
`;
}

async function toStatus(projectDir: string, meta: ProjectStatus['meta']): Promise<ProjectStatus> {
  const disk = await scanProjectDisk(projectDir);
  return { meta, disk, scenes: sceneCompletion(meta.progress, disk, meta.expectedSceneCount) };
}

export interface DraftOptions {
  title?: string;
  done?: boolean;
}

/** `sw draft` 的引擎入口（行为矩阵 D1–D7）。 */
export async function runDraftScene(
  projectDir: string,
  rawSceneId: string,
  options: DraftOptions = {},
): Promise<DraftOutcome> {
  // D6：编号形态校验（归一规则 §3-7）
  const sceneId = normalizeSceneId(rawSceneId);
  const loaded = await loadProject(projectDir);
  if (!loaded.ok) {
    failProject(loaded, projectDir);
  }
  const disk0 = await scanProjectDisk(projectDir);
  if (sceneId === null) {
    fail('SW-E032', { sceneId: rawSceneId, existingIds: disk0.sceneIds });
  }

  // D4/D5：--done 路径（磁盘存在性防线前置，防 scenes_done 与磁盘漂移）
  if (options.done === true) {
    const existing = await findSceneFileById(projectDir, sceneId);
    if (existing === undefined) {
      fail('SW-E030', { sceneId, existingIds: disk0.sceneIds });
    }
    const marked = await markSceneDone(projectDir, sceneId);
    if (!marked.ok) {
      failProject(marked, projectDir);
    }
    return {
      action: 'done',
      sceneId,
      fileName: existing,
      outlineFilled: false,
      titleIgnored: false,
      status: await toStatus(projectDir, marked.meta),
    };
  }

  // D3：outline 缺失或全空白 → 先自动补大纲骨架（MP-05）
  const outlineState = await inspectOutlineFile(projectDir);
  let outlineFilled = false;
  let meta = loaded.meta;
  if (!outlineState.exists || outlineState.blank) {
    const outlined = await ensureOutline(projectDir);
    if (!outlined.ok) {
      failProject(outlined, projectDir);
    }
    outlineFilled = outlined.action === 'created';
    meta = outlined.status.meta;
  }

  // D2：按编号幂等保留（不看 slug；--title 不消费并如实报告）
  const existing = await findSceneFileById(projectDir, sceneId);
  if (existing !== undefined) {
    return {
      action: 'kept',
      sceneId,
      fileName: existing,
      outlineFilled,
      titleIgnored: options.title !== undefined,
      status: await toStatus(projectDir, meta),
    };
  }

  // D1：创建场骨架（原子写）→ 步骤补齐到 draft → 原子回写
  const title = options.title ?? `场 ${sceneId}`;
  const fileName = `${sceneId}-${sceneSlug(options.title)}.md`;
  await writeSceneFile(projectDir, fileName, renderSceneSkeleton(sceneId, title, fileName));
  const progress = ensureStepAtLeast(meta.progress, 'draft');
  if (progress !== meta.progress) {
    meta = { ...meta, progress };
    await saveProject(projectDir, meta);
  }
  return {
    action: 'created',
    sceneId,
    fileName,
    outlineFilled,
    titleIgnored: false,
    status: await toStatus(projectDir, meta),
  };
}
