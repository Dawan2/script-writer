/**
 * 基础设施·outline.md 存取适配器（SPEC-02 `sw outline`："打开/创建 outline.md，
 * 若为空写入模板骨架"）。读侧探测三态（缺失 / 全空白 / 有内容）供应用层决定是否写骨架；
 * 写侧走 writeFileAtomic（临时文件 + rename），与 project.yaml 同一中断安全语义。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicFile.js';
import { OUTLINE_FILE } from './layout.js';

export type OutlineFileState =
  | { exists: false }
  /** blank = 0 字节或仅空白字符——SPEC-02 视同"为空"，可写模板骨架不算覆盖。 */
  | { exists: true; blank: boolean };

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** 探测项目目录下 outline.md 的状态（不读入应用层，避免大文件内容穿层）。 */
export async function inspectOutlineFile(projectDir: string): Promise<OutlineFileState> {
  let text: string;
  try {
    text = await readFile(join(projectDir, OUTLINE_FILE), 'utf8');
  } catch (error) {
    if (isFsError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { exists: false };
    }
    throw error;
  }
  return { exists: true, blank: text.trim().length === 0 };
}

/** 原子写入 outline.md（骨架落盘；任意时刻中断磁盘上只有旧/新两态）。 */
export async function writeOutlineFile(projectDir: string, content: string): Promise<void> {
  await writeFileAtomic(join(projectDir, OUTLINE_FILE), content);
}

/**
 * 读取 outline.md 原文（SPEC-06 §5.2 聚合数据源）；文件缺失返回 null。
 * 空白判定与修剪由调用方负责（export 的全空白省略带 §5.2-2）。
 */
export async function readOutlineText(projectDir: string): Promise<string | null> {
  try {
    return await readFile(join(projectDir, OUTLINE_FILE), 'utf8');
  } catch (error) {
    if (isFsError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return null;
    }
    throw error;
  }
}
