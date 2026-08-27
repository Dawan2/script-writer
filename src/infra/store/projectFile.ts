/**
 * 基础设施·project.yaml 存取与项目目录扫描（SPEC-02 单一状态源的存储适配器）。
 * 读：YAML 文本 → 普通对象（校验交给核心域 parseProjectMeta，本层不懂 schema）。
 * 写：领域模型 → 磁盘形态 → YAML 文本 → writeFileAtomic（先写临时文件再 rename）。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { ProjectMeta } from '../../core/model/project.js';
import { toProjectFileShape } from '../../core/model/parseProject.js';
import type { ProjectDiskSnapshot } from '../../core/model/progress.js';
import { writeFileAtomic } from './atomicFile.js';
import { OUTLINE_FILE, PROJECT_FILE, SCENES_DIR } from './layout.js';

export type RawProjectFileResult =
  /** 目录下没有 project.yaml（SW-E011 语义：不是 script-writer 项目）。 */
  | { exists: false }
  | { exists: true; ok: true; data: unknown }
  /** 文件存在但不是合法 YAML。 */
  | { exists: true; ok: false; detail: string };

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** 读取项目目录下的 project.yaml 原始数据体（不做 schema 校验）。 */
export async function readProjectFileRaw(projectDir: string): Promise<RawProjectFileResult> {
  let text: string;
  try {
    text = await readFile(join(projectDir, PROJECT_FILE), 'utf8');
  } catch (error) {
    if (isFsError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { exists: false };
    }
    throw error;
  }
  try {
    return { exists: true, ok: true, data: parse(text) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { exists: true, ok: false, detail };
  }
}

/** 原子写回 project.yaml（SPEC-02 引擎数据流 ④）。 */
export async function writeProjectFile(projectDir: string, meta: ProjectMeta): Promise<void> {
  const text = stringify(toProjectFileShape(meta));
  await writeFileAtomic(join(projectDir, PROJECT_FILE), text);
}

/** 场文件名中的场编号（P1 §6.1：scenes/010-opening.md → "010"）。 */
const SCENE_FILE = /^(\d{3,})-.*\.md$/;

/** 扫描项目目录，产出核心域需要的只读快照（outline 是否存在、实际场编号列表）。 */
export async function scanProjectDisk(projectDir: string): Promise<ProjectDiskSnapshot> {
  const outlineExists = await stat(join(projectDir, OUTLINE_FILE)).then(
    (info) => info.isFile(),
    () => false,
  );

  const sceneIds = await readdir(join(projectDir, SCENES_DIR)).then(
    (entries) =>
      entries
        .map((name) => SCENE_FILE.exec(name)?.[1])
        .filter((id): id is string => id !== undefined)
        .sort(),
    () => [] as string[],
  );

  return { outlineExists, sceneIds };
}
