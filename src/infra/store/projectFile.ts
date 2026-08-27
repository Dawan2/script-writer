/**
 * 基础设施·project.yaml 存取与项目目录扫描/物化（SPEC-02 单一状态源的存储适配器）。
 *
 * 读：YAML 文本 → 普通对象（校验交给核心域 parseProjectMeta，本层不懂 schema）。
 * 写：领域模型 → 磁盘形态 → YAML 文本 → writeFileAtomic（先写临时文件再 rename）。
 *
 * W3 集成（语义冲突 ⑤ 核销）：本文件为 project.yaml 读写正典（engine 版，`yaml` 库 +
 * parseProject.ts 纯函数互转）；init 分支的 `inspectDir`/`materializeProjectDir`
 * （目录状态检查 + 项目目录原子物化）系 engine 没有的能力，迁入本模块保留；
 * init 版手写序列化 `serializeProjectMeta` 废弃，统一走 `serializeProjectFile`
 * （toProjectFileShape + yaml.stringify）。
 */

import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';
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

/** ProjectMeta → project.yaml 文本（唯一序列化路径；init 物化与引擎回写共用）。 */
export function serializeProjectFile(meta: ProjectMeta): string {
  return stringify(toProjectFileShape(meta));
}

/** 原子写回 project.yaml（SPEC-02 引擎数据流 ④）。 */
export async function writeProjectFile(projectDir: string, meta: ProjectMeta): Promise<void> {
  await writeFileAtomic(join(projectDir, PROJECT_FILE), serializeProjectFile(meta));
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

// ---------------------------------------------------------------------------
// 目录状态检查与项目目录物化（自 init 分支迁移保留，SPEC-01 数据流的原子写入环节）
// ---------------------------------------------------------------------------

export type DirState = 'missing' | 'empty' | 'non-empty' | 'file';

/** 待写入的项目文件（相对项目根的 POSIX 路径 + utf8 内容）。 */
export interface ProjectFileEntry {
  relPath: string;
  content: string;
}

/** 目标路径状态检查（SW-E010/SW-E013 判定的输入）。 */
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

export interface MaterializeOptions {
  /** 目标目录状态（调用方已用 inspectDir 判定并处理过 SW-E010/E013 分支） */
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

/**
 * 项目目录物化：临时目录写完后 rename，避免半成品项目（SPEC-01）：
 * 目标缺失 → 整目录单次 rename（完全原子）；
 * 目标为空目录 → 按顶层条目逐一 rename（不 rmdir 目标，避免它是进程 cwd）；
 * 目标非空 + overwrite（--force）→ 逐文件 writeFileAtomic 原子覆盖，
 * 只覆盖同名脚手架文件，不删除用户既有文件。
 */
export async function materializeProjectDir(
  target: string,
  files: ProjectFileEntry[],
  options: MaterializeOptions,
): Promise<void> {
  const ensureDirs = options.ensureDirs ?? [];

  if (options.dirState === 'non-empty') {
    // --force 路径：逐文件原子覆盖（复用 atomicFile 原语），不动其余用户文件。
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
