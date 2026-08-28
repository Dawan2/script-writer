/**
 * 项目锁原语单测（SPEC-07 §9：AT-L02/L06/L08/L09/L10/L11 的原语层断言；
 * 进程级互斥 AT-L01/L14 与矩阵覆盖 AT-L15 在 tests/cli/lock.spec.ts）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireProjectLock,
  isPidAlive,
  parseLockContent,
  releaseProjectLock,
  renderLockContent,
  withProjectLock,
  type LockDeps,
} from '../../src/infra/store/lock.js';
import { LOCK_FILE } from '../../src/infra/store/layout.js';
import { isSwError } from '../../src/app/errors/registry.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sw-lock-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lockPath = (): string => path.join(dir, LOCK_FILE);

async function plantLock(content: string): Promise<void> {
  await mkdir(path.dirname(lockPath()), { recursive: true });
  await writeFile(lockPath(), content, 'utf8');
}

async function expectE012(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    expect.unreachable('应抛 SW-E012');
  } catch (error) {
    expect(isSwError(error)).toBe(true);
    if (isSwError(error)) {
      expect(error.code).toBe('SW-E012');
      return (error.ctx as { holder: string }).holder;
    }
  }
  throw new Error('unreachable');
}

describe('infra/store/lock：内容 schema（AT-L08）', () => {
  it('三键齐备无多余键、往返无损、acquired_at 秒级 UTC ISO-8601', () => {
    const content = { pid: 12345, hostname: 'writers-laptop', acquiredAt: '2026-08-28T02:31:07Z' };
    const text = renderLockContent(content);
    expect(text).toBe('pid: 12345\nhostname: writers-laptop\nacquired_at: 2026-08-28T02:31:07Z\n');
    expect(parseLockContent(text)).toEqual(content);
  });

  it('空文件 / 缺键 / 多键 / 非法 pid / 非法日期 → null（不可解析）', () => {
    expect(parseLockContent('')).toBeNull();
    expect(parseLockContent('pid: 1\nhostname: h\n')).toBeNull();
    expect(
      parseLockContent('pid: 1\nhostname: h\nacquired_at: 2026-08-28T02:31:07Z\nextra: x\n'),
    ).toBeNull();
    expect(parseLockContent('pid: abc\nhostname: h\nacquired_at: 2026-08-28T02:31:07Z\n')).toBeNull();
    expect(parseLockContent('pid: 1\nhostname: h\nacquired_at: 昨天\n')).toBeNull();
  });
});

describe('infra/store/lock：获取 / 释放 / stale 接管', () => {
  it('空闲获取成功：写入本进程 pid 与 hostname；释放后锁文件消失', async () => {
    const result = await acquireProjectLock(dir);
    expect(result.tookOver).toBeNull();
    const content = parseLockContent(await readFile(lockPath(), 'utf8'));
    expect(content?.pid).toBe(process.pid);
    expect(content?.hostname).toBe(os.hostname());
    await releaseProjectLock(dir);
    await expect(readFile(lockPath(), 'utf8')).rejects.toThrow();
  });

  it('活锁（本进程 pid）→ E012，holder 含 pid 与主机名（AT-L01 原语层）', async () => {
    await acquireProjectLock(dir);
    const holder = await expectE012(() => acquireProjectLock(dir));
    expect(holder).toContain(`pid ${process.pid}`);
    expect(holder).toContain(os.hostname());
    await releaseProjectLock(dir);
  });

  it('stale 锁自动接管（AT-L02）：恰一行告警、锁内容更新、主体照常执行', async () => {
    const deadPid = 2 ** 22 + 54321;
    await plantLock(`pid: ${deadPid}\nhostname: ${os.hostname()}\nacquired_at: 2026-08-27T10:00:00Z\n`);
    const warnings: string[] = [];
    const value = await withProjectLock(dir, async () => 'done', (line) => warnings.push(line));
    expect(value).toBe('done');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`pid ${deadPid} 已不存活`);
    expect(warnings[0]).toContain('已自动接管');
    // finally 释放：主体结束后锁文件不存在（AT-L06 成功分支）
    await expect(readFile(lockPath(), 'utf8')).rejects.toThrow();
  });

  it('AT-L06 失败分支：主体 fail() 抛错后锁同样释放', async () => {
    await expect(
      withProjectLock(dir, async () => {
        throw new Error('主体失败');
      }),
    ).rejects.toThrow('主体失败');
    await expect(readFile(lockPath(), 'utf8')).rejects.toThrow();
  });

  it('不可解析锁 → E012（holder=未知）且不自动接管、锁原样留存（AT-L09）', async () => {
    await plantLock('');
    const holder = await expectE012(() => acquireProjectLock(dir));
    expect(holder).toContain('未知（锁文件内容不完整或损坏）');
    expect(await readFile(lockPath(), 'utf8')).toBe(''); // 未被接管
  });

  it('他机 hostname 锁 → E012 含他机名、不接管（AT-L10 写命令侧）', async () => {
    await plantLock('pid: 99999\nhostname: other-machine\nacquired_at: 2026-08-28T02:31:07Z\n');
    const holder = await expectE012(() => acquireProjectLock(dir));
    expect(holder).toContain('other-machine');
    expect(await readFile(lockPath(), 'utf8')).toContain('other-machine');
  });

  it('pid 存活探测：本进程存活；远离活跃空间的 pid 不存活', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 11111)).toBe(false);
  });

  it('接管竞态（AT-L11）：unlink 后重建遇 EEXIST → 恰一次重试后 E012，无循环无死锁', async () => {
    const deadPid = 2 ** 22 + 22222;
    await plantLock(`pid: ${deadPid}\nhostname: ${os.hostname()}\nacquired_at: 2026-08-27T10:00:00Z\n`);
    // 注入确定性序列（§3.5 测试缝）：第一次创建抛 EEXIST（走 stale 判定）；
    // 第二次（接管重建）模拟赢家抢先——写入赢家的活锁并抛 EEXIST。
    let call = 0;
    const deps: LockDeps = {
      pid: () => process.pid,
      hostname: () => os.hostname(),
      now: () => new Date(),
      pidAlive: (pid) => pid !== deadPid, // 死锁判定 stale
      writeExclusive: async (p) => {
        call += 1;
        const error = new Error('EEXIST') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        if (call === 2) {
          await writeFile(
            p,
            `pid: ${process.pid}\nhostname: ${os.hostname()}\nacquired_at: 2026-08-28T03:00:00Z\n`,
            'utf8',
          );
        }
        throw error;
      },
    };
    const holder = await expectE012(() => acquireProjectLock(dir, deps));
    expect(call).toBe(2); // 恰一次重试
    expect(holder).toContain(`pid ${process.pid}`); // 输家看到赢家的活锁
  });
});
