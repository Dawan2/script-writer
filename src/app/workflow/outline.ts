/**
 * 应用层·`sw outline` 最小版（W1-P1-T07，SPEC-02："打开/创建 outline.md，
 * 若为空写入模板骨架——空态三要素内嵌为 Markdown 注释"）。
 * 数据流与引擎各入口同构（engine.ts ①–⑤）：①读取校验 project.yaml ②探测 outline.md 缺口
 * ③缺失/为空时按 format 渲染模板骨架并原子写入 ④步骤补齐到 draft 后原子回写状态
 * ⑤把结构化结果交渲染层（outlineReport.ts）输出。
 * 幂等约束（P1 §6.2）：outline.md 已有内容时只报告不覆盖（覆盖属 --force 语义，非本最小版范围）。
 * TODO(W1-P1-T06)：SPEC-03 错误框架合入后，失败分支迁移为 fail(code, ctx) 唯一入口。
 */

import {
  DEFAULT_EXPECTED_SCENE_COUNT,
  type ProjectMeta,
} from '../../core/model/project.js';
import { ensureStepAtLeast, sceneCompletion } from '../../core/model/progress.js';
import { OUTLINE_FILE } from '../../infra/store/layout.js';
import { inspectOutlineFile, writeOutlineFile } from '../../infra/store/outlineFile.js';
import { scanProjectDisk } from '../../infra/store/projectFile.js';
import { loadTemplate, renderTemplateFiles } from '../../infra/store/templates.js';
import {
  loadProject,
  saveProject,
  type ProjectFailure,
  type ProjectStatus,
} from './engine.js';

/** created = 本次写入了模板骨架；kept = 已有内容，幂等未动。 */
export type OutlineAction = 'created' | 'kept';

export interface OutlineOutcome {
  action: OutlineAction;
  status: ProjectStatus;
}

export type EnsureOutlineResult = ({ ok: true } & OutlineOutcome) | ProjectFailure;

/**
 * 按项目脚本类型（format）渲染 outline.md 骨架文本。
 * 变量：{{title}} ← 项目标题；{{expectedSceneCount}} ← 预计场数（缺省 5，SPEC-01 默认值）。
 * 三个内置模板与 format 枚举同名同集（模板库结构有单测锁定），故 format 即模板 id。
 */
export async function renderOutlineSkeleton(meta: ProjectMeta): Promise<string> {
  const files = await loadTemplate(meta.format);
  const outline = files.find((file) => file.relPath === OUTLINE_FILE);
  if (outline === undefined) {
    throw new Error(
      `内置模板 ${meta.format} 缺少 ${OUTLINE_FILE}——安装可能损坏，请重新安装 script-writer`,
    );
  }
  const rendered = renderTemplateFiles([outline], {
    title: meta.title,
    expectedSceneCount: String(meta.expectedSceneCount ?? DEFAULT_EXPECTED_SCENE_COUNT),
  });
  return rendered[0]?.content ?? '';
}

/** `sw outline` 的引擎入口：确保大纲文件就位，并把步骤补齐到 draft（只进不退）。 */
export async function ensureOutline(projectDir: string): Promise<EnsureOutlineResult> {
  const loaded = await loadProject(projectDir);
  if (!loaded.ok) {
    return loaded;
  }

  const outlineState = await inspectOutlineFile(projectDir);
  const needsSkeleton = !outlineState.exists || outlineState.blank;
  if (needsSkeleton) {
    await writeOutlineFile(projectDir, await renderOutlineSkeleton(loaded.meta));
  }

  // 大纲就位后步骤至少推进到 draft：status 的下一步建议随之指向具体场命令，
  // 避免"永远建议 sw outline"的死循环（ensureStepAtLeast 幂等、只进不退）。
  const progress = ensureStepAtLeast(loaded.meta.progress, 'draft');
  let meta = loaded.meta;
  if (progress !== loaded.meta.progress) {
    meta = { ...loaded.meta, progress };
    await saveProject(projectDir, meta);
  }

  const disk = await scanProjectDisk(projectDir);
  return {
    ok: true,
    action: needsSkeleton ? 'created' : 'kept',
    status: { meta, disk, scenes: sceneCompletion(meta.progress, disk) },
  };
}
