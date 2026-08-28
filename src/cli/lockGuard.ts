/**
 * 接口层·写命令锁接线（SPEC-07 §3.5/§6，W4-LOCK-T01）。
 *
 * 全库唯一取装点：写命令的 action 主体经 runWithProjectLock 包装；
 * app 层工作流函数一律不取锁（嵌套调用结构性无重入，§3.5）。
 *
 * 执行次序（既有项目写命令，§3.5）：① argparse（commander，退出码 2 不触锁）
 * ② 探测 project.yaml 存在性——缺失则不取锁直接走既有 SW-E011 失败路径
 * （防止在任意非项目目录留下 .sw/ 垃圾）③ 取锁（含 stale 接管）
 * ④ 命令主体（读-改-写全程在锁内）⑤ finally 释放。
 *
 * LOCKED_WRITE_COMMANDS 是 AT-L15 表驱动覆盖度测试的数据源（§6.3 漏接线防线）：
 * 新写命令未进清单或未接线，测试即红。只读命令（status / doctor / revise --list /
 * help）不加锁，不入清单。
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withProjectLock } from '../infra/store/lock.js';
import { PROJECT_FILE } from '../infra/store/layout.js';
import type { CliIo } from './io.js';

/** 锁矩阵 v1「加锁」行清单（SPEC-07 §6.1；check/snapshot/restore 等未实现命令落地时追加）。 */
export const LOCKED_WRITE_COMMANDS = ['init', 'outline', 'draft', 'revise', 'export'] as const;

/**
 * 既有项目写命令的锁包装：② 存在性探测（cheap stat，不解析）→ ③ 取锁 → ④⑤ 主体与释放。
 * 接管/释放告警经 io.err 发 stderr（stdout 末行可复制契约零污染）。
 */
export async function runWithProjectLock<T>(
  io: CliIo,
  projectDir: string,
  body: () => Promise<T>,
): Promise<T> {
  const projectFileExists = await stat(join(projectDir, PROJECT_FILE)).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!projectFileExists) {
    return body();
  }
  return withProjectLock(projectDir, body, (line) => io.err(line));
}
