/**
 * 基础设施·原子写文件原语（SPEC-02"状态回写与文件产出在同一事务语义内"）。
 * 实现：同目录写临时文件 → fsync → rename。POSIX 下 rename 原子，
 * 因此进程在任意时刻被 kill（含 kill -9），目标文件要么是旧内容、要么是新内容，绝无半成品。
 */

import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** 原子写入 UTF-8 文本；目标已存在则原子替换。临时文件与目标同目录（跨设备 rename 不原子）。 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`,
  );

  try {
    const handle = await open(tmpPath, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    // 失败时尽力清理临时文件，不留残骸；原始错误原样上抛
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
