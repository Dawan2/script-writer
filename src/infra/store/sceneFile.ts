/**
 * 基础设施·场文件存取适配器（SPEC-05 §4.3 / §3-7 场编号词汇）。
 * 读侧：按编号在 scenes/ 中探测场文件（编号判定，不看 slug）；列出场文件名（升序，export 聚合用）。
 * 写侧：writeFileAtomic 原子落盘（与 project.yaml / outline.md 同一中断安全语义）。
 */

import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicFile.js';
import { padSceneId, SCENES_DIR } from './layout.js';

/** 场文件名中的场编号（沿用 scanProjectDisk 口径：^(\d{3,})-.*\.md$）。 */
const SCENE_FILE = /^(\d{3,})-.*\.md$/;

/**
 * 场编号归一（SPEC-05 §3-7）：`^\d{1,3}$` 归一为 3 位零填充（10 ≡ 010）；
 * `^\d{4,}$` 原样；其余形态返回 null（调用方报 SW-E032 / SW-E030）。
 */
export function normalizeSceneId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{1,3}$/.test(trimmed)) {
    return padSceneId(Number.parseInt(trimmed, 10));
  }
  if (/^\d{4,}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/** 场文件名列表（文件名升序；scenes/ 缺失视为空——SPEC-06 §5.2-2 的空节判定面）。 */
export async function listSceneFiles(projectDir: string): Promise<string[]> {
  return readdir(join(projectDir, SCENES_DIR)).then(
    (entries) => entries.filter((name) => SCENE_FILE.test(name)).sort(),
    () => [] as string[],
  );
}

/** 按编号找场文件名（编号判定不看 slug，SPEC-05 §4.2-D2）；找不到返回 undefined。 */
export async function findSceneFileById(
  projectDir: string,
  sceneId: string,
): Promise<string | undefined> {
  const files = await listSceneFiles(projectDir);
  return files.find((name) => SCENE_FILE.exec(name)?.[1] === sceneId);
}

/** 原子写入场文件（骨架落盘；任意时刻中断磁盘上只有旧/新两态）。 */
export async function writeSceneFile(
  projectDir: string,
  fileName: string,
  content: string,
): Promise<void> {
  const dir = join(projectDir, SCENES_DIR);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, fileName), content);
}

/** 读取全部场文件原文（文件名升序，SPEC-06 §5.2 聚合数据源；scenes/ 缺失视为空）。 */
export async function readSceneFiles(
  projectDir: string,
): Promise<{ fileName: string; content: string }[]> {
  const names = await listSceneFiles(projectDir);
  return Promise.all(
    names.map(async (fileName) => ({
      fileName,
      content: await readFile(join(projectDir, SCENES_DIR, fileName), 'utf8'),
    })),
  );
}
