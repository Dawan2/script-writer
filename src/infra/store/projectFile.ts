/**
 * 基础设施·项目文件存储（SPEC-01 数据流的"项目存储原子写入"环节）。
 *
 * - `serializeProjectMeta`：ProjectMeta → project.yaml（schema v1）。字段名与
 *   SPEC-01 示例逐字一致（含 `scenes_done` 蛇形与 GAP-03 `expectedSceneCount`
 *   驼峰的既登记差异——引用后不改义，禁止"顺手统一"）。
 * - `materializeProjectDir`：临时目录写完后 rename，避免半成品项目：
 *   目标缺失 → 整目录单次 rename（完全原子）；
 *   目标为空目录 → 按顶层条目逐一 rename（不 rmdir 目标，避免它是进程 cwd）；
 *   目标非空 + overwrite（--force）→ 逐文件"临时文件 + rename"原子覆盖，
 *   只覆盖同名脚手架文件，不删除用户既有文件。
 */

import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProjectMeta } from '../../core/model/project.js';
import { PROJECT_FILE } from './layout.js';

export type DirState = 'missing' | 'empty' | 'non-empty' | 'file';

/** 待写入的项目文件（相对项目根的 POSIX 路径 + utf8 内容）。 */
export interface ProjectFileEntry {
  relPath: string;
  content: string;
}

/** 目标路径状态检查（SW-E010 判定的输入）。 */
export async function inspectDir(dir: string): Promise<DirState> {
  let info;
  try {
    info = await stat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
  if (!info.isDirectory()) {
    return 'file';
  }
  const entries = await readdir(dir);
  return entries.length === 0 ? 'empty' : 'non-empty';
}

/**
 * ProjectMeta → project.yaml 文本。schema 固定且 title 经 JSON 转义
 * （YAML 1.2 双引号标量是 JSON 字符串超集），无需引入 YAML 依赖；
 * 解析侧（读取/校验）属 W1-P1-T05 的引擎范围。
 */
export function serializeProjectMeta(meta: ProjectMeta): string {
  const lines: string[] = [
    `schema: ${meta.schema}`,
    `title: ${JSON.stringify(meta.title)}`,
    `format: ${meta.format}`,
    `created: ${meta.created}`,
  ];
  if (meta.expectedSceneCount !== undefined) {
    lines.push(`expectedSceneCount: ${meta.expectedSceneCount}`);
  }
  lines.push(
    'settings:',
    `  ai: { enabled: ${meta.settings.ai.enabled}, provider: ${meta.settings.ai.provider === null ? 'null' : JSON.stringify(meta.settings.ai.provider)} }`,
    `  export: { default: ${meta.settings.export.default} }`,
    'progress:',
    `  step: ${meta.progress.step}`,
    `  scenes_done: [${meta.progress.scenesDone.map((id) => JSON.stringify(id)).join(', ')}]`,
  );
  return lines.join('\n') + '\n';
}

export interface MaterializeOptions {
  /** 目标目录状态（调用方已用 inspectDir 判定并处理过 SW-E010 分支） */
  dirState: DirState;
  /** 需要确保存在的空目录（相对项目根），如 exports/ */
  ensureDirs?: string[];
}

async function writeEntries(root: string, files: ProjectFileEntry[], ensureDirs: string[]): Promise<void> {
  for (const dir of ensureDirs) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  for (const file of files) {
    const abs = path.join(root, file.relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, file.content, 'utf8');
  }
}

/** 单文件原子写：同目录临时文件写完后 rename（POSIX 下对既有文件的 rename 原子生效）。 */
async function writeFileAtomic(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.tmp-${randomUUID().slice(0, 8)}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, abs);
}

export async function materializeProjectDir(
  target: string,
  files: ProjectFileEntry[],
  options: MaterializeOptions,
): Promise<void> {
  const ensureDirs = options.ensureDirs ?? [];

  if (options.dirState === 'non-empty') {
    // --force 路径：逐文件原子覆盖，不动其余用户文件。
    for (const dir of ensureDirs) {
      await mkdir(path.join(target, dir), { recursive: true });
    }
    for (const file of files) {
      const abs = path.join(target, file.relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFileAtomic(abs, file.content);
    }
    return;
  }

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const tmp = await mkdtemp(path.join(parent, '.sw-init-'));
  try {
    await writeEntries(tmp, files, ensureDirs);
    if (options.dirState === 'missing') {
      await rename(tmp, target);
      return;
    }
    // 目标是既有空目录：逐顶层条目 rename（目标内不存在同名条目，全部一步到位）。
    const topEntries = await readdir(tmp);
    for (const entry of topEntries) {
      await rename(path.join(tmp, entry), path.join(target, entry));
    }
    await rm(tmp, { recursive: true, force: true });
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}

export { PROJECT_FILE };
