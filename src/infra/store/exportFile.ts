/**
 * 基础设施·导出产物写盘适配器（SPEC-06 §5.2-5）。
 * 父目录自动创建（--out 可指向不存在的目录；exports/ 缺省路径被删时自动重建），
 * 写入走 writeFileAtomic；派生产物允许覆盖（确定性重导出 = 刷新，无需 --force）。
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from './atomicFile.js';

/** 原子写入导出产物（absPath 由应用层解析；父目录递归创建）。 */
export async function writeExportFile(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFileAtomic(absPath, content);
}
