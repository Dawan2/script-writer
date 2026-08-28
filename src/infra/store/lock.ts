/**
 * 基础设施·项目级建议性文件锁（SPEC-07 / GAP-04，W4-LOCK-T01）。
 *
 * 形态：`<项目根>/.sw/lock`，**独占创建（'wx' = O_EXCL）即持有**——互斥凭据是文件的存在
 * 本身，内容（pid/hostname/acquired_at）只是元数据；不用 flock/fcntl（可移植性裁定）。
 * 瞬态互斥件、非状态源（ADR-0002）：删除无持有者的锁后行为不变，下次写命令自动重建。
 *
 * stale 判定（§4）：同机 + pid 不存活 → 自动接管（unlink + 重建，只重试一次，
 * 接管竞态输家 E012）；他机 hostname / 不可解析内容 → 按持有中处理 fail SW-E012（不自愈）。
 * 释放（§3.4）：finally 语义 + 尽力而为（ENOENT 静默；其他失败告警一行，不改退出码）。
 *
 * 接线纪律（§3.5）：只有 CLI 命令层的统一包装器（src/cli/lockGuard.ts）可取锁；
 * app 层工作流函数一律不取锁——嵌套调用（draft D3 → ensureOutline）结构性无重入。
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fail } from '../../app/errors/registry.js';
import { LOCK_FILE } from './layout.js';

/** 锁文件内容（§3.2 schema v1：三键齐备、无更多键）。 */
export interface LockContent {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

/** 可注入依赖（§3.5 测试缝：AT-L02/L10/L11 注入式单测）。 */
export interface LockDeps {
  pid(): number;
  hostname(): string;
  now(): Date;
  /** 同机 pid 存活探测（process.kill(pid, 0)：ESRCH → 不存活；EPERM → 存活）。 */
  pidAlive(pid: number): boolean;
  /** 独占创建写入（'wx' 语义；EEXIST 必须抛 code='EEXIST' 的异常）。 */
  writeExclusive(lockPath: string, text: string): Promise<void>;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const DEFAULT_DEPS: LockDeps = {
  pid: () => process.pid,
  hostname: () => os.hostname(),
  now: () => new Date(),
  pidAlive: defaultPidAlive,
  writeExclusive: (lockPath, text) => writeFile(lockPath, text, { flag: 'wx' }),
};

/** 同机 pid 存活探测（doctor 检查项与取锁路径共用；SPEC-07 §4.2）。 */
export const isPidAlive: (pid: number) => boolean = defaultPidAlive;

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isoUtcSecond(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 序列化锁内容（§3.2：三行标量 YAML 子集，秒级 UTC ISO-8601）。 */
export function renderLockContent(content: LockContent): string {
  return `pid: ${content.pid}\nhostname: ${content.hostname}\nacquired_at: ${content.acquiredAt}\n`;
}

/** 解析锁内容：空文件 / 缺键 / 形态非法 → null（§4.4 不可解析锁，不自愈）。 */
export function parseLockContent(text: string): LockContent | null {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = /^([a-z_]+):\s*(.+)$/.exec(line);
    if (match === null) {
      return null;
    }
    fields.set(match[1]!, match[2]!.trim());
  }
  const pidRaw = fields.get('pid');
  const hostname = fields.get('hostname');
  const acquiredAt = fields.get('acquired_at');
  if (pidRaw === undefined || hostname === undefined || acquiredAt === undefined) {
    return null;
  }
  if (fields.size !== 3) {
    return null; // 三键齐备、无更多键
  }
  const pid = Number(pidRaw);
  if (!Number.isInteger(pid) || pid <= 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(acquiredAt)) {
    return null;
  }
  return { pid, hostname, acquiredAt };
}

/** E012 持有者字段渲染（§5：不可解析时显示「未知（锁文件内容不完整或损坏）」）。 */
function holderText(holder: LockContent | null): string {
  if (holder === null) {
    return '未知（锁文件内容不完整或损坏）';
  }
  return `pid ${holder.pid}（主机 ${holder.hostname}，获取于 ${holder.acquiredAt}）`;
}

function failLocked(dir: string, holder: LockContent | null): never {
  fail('SW-E012', { dir, holder: holderText(holder) });
}

export interface AcquireResult {
  /** 非 null = 本进程自动接管了陈旧锁（接管告警由调用方发 stderr）。 */
  tookOver: LockContent | null;
}

async function tryExclusiveCreate(
  deps: LockDeps,
  lockPath: string,
  self: LockContent,
): Promise<boolean> {
  try {
    // 锁文件不走 writeFileAtomic（temp+rename 绕过 O_EXCL 会摧毁互斥，§3.3）
    await deps.writeExclusive(lockPath, renderLockContent(self));
    return true;
  } catch (error) {
    if (isFsError(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error; // EEXIST 之外的失败不属锁语义：原样上抛（§3.3）
  }
}

/**
 * 获取项目锁（§3.3 获取协议 + §4 stale 判定/接管）。
 * 占用中（含他机锁、不可解析锁、接管竞态输家）→ fail('SW-E012')。
 */
export async function acquireProjectLock(
  dir: string,
  deps: LockDeps = DEFAULT_DEPS,
): Promise<AcquireResult> {
  const lockPath = join(dir, LOCK_FILE);
  await mkdir(dirname(lockPath), { recursive: true });
  const self: LockContent = {
    pid: deps.pid(),
    hostname: deps.hostname(),
    acquiredAt: isoUtcSecond(deps.now()),
  };
  if (await tryExclusiveCreate(deps, lockPath, self)) {
    return { tookOver: null };
  }

  // EEXIST → stale 判定（§4.1：读时恰好释放则重试独占创建一次）
  let text: string;
  try {
    text = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (isFsError(error) && error.code === 'ENOENT') {
      if (await tryExclusiveCreate(deps, lockPath, self)) {
        return { tookOver: null };
      }
      text = await readFile(lockPath, 'utf8'); // 再失败按当次内容重新判定
    } else {
      throw error;
    }
  }

  const holder = parseLockContent(text);
  if (holder === null) {
    failLocked(dir, null); // §4.4：不可解析锁不自动接管
  }
  if (holder.hostname !== deps.hostname()) {
    failLocked(dir, holder); // §4.2：他机锁无法判定存活，按持有中处理
  }
  if (deps.pidAlive(holder.pid)) {
    failLocked(dir, holder); // 存活（含 EPERM）→ 持有中
  }

  // stale → 自动接管（§4.3：unlink + 重建只重试一次，竞态输家 E012）
  await unlink(lockPath).catch((error: unknown) => {
    if (!(isFsError(error) && error.code === 'ENOENT')) {
      throw error;
    }
  });
  if (await tryExclusiveCreate(deps, lockPath, self)) {
    return { tookOver: holder };
  }
  const current = parseLockContent(await readFile(lockPath, 'utf8').catch(() => ''));
  failLocked(dir, current);
}

/**
 * 释放项目锁（§3.4 尽力而为）：ENOENT 静默容忍；其他失败经 onWarn 告警一行，
 * 不改变命令退出码（本进程退出后残锁由下次写命令按 stale 自动接管，自愈闭环）。
 */
export async function releaseProjectLock(dir: string, onWarn?: (line: string) => void): Promise<void> {
  try {
    await unlink(join(dir, LOCK_FILE));
  } catch (error) {
    if (isFsError(error) && error.code === 'ENOENT') {
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    onWarn?.(`⚠ 项目锁释放失败：${reason}；下次写命令将按陈旧锁自动接管\n`);
  }
}

/**
 * 高层包装（§3.5）：取锁 → 执行 → finally 释放。
 * 接管告警（恰一行）与释放失败告警均走 onWarn（stderr），stdout「末行可复制」契约零污染。
 */
export async function withProjectLock<T>(
  dir: string,
  fn: () => Promise<T>,
  onWarn?: (line: string) => void,
  deps: LockDeps = DEFAULT_DEPS,
): Promise<T> {
  const { tookOver } = await acquireProjectLock(dir, deps);
  if (tookOver !== null) {
    onWarn?.(
      `⚠ 检测到陈旧项目锁（pid ${tookOver.pid} 已不存活，acquired_at ${tookOver.acquiredAt}），已自动接管\n`,
    );
  }
  try {
    return await fn();
  } finally {
    await releaseProjectLock(dir, onWarn);
  }
}
