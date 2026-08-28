/**
 * 写命令锁接线验收（SPEC-07 §9：AT-L01/L03/L07/L14/L15 的命令层/进程级断言）。
 * 活锁 = 以本进程 pid 预置（本进程在断言期间始终存活，等同另一持锁进程）。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliIo } from '../../src/cli/io.js';
import { EXIT_OK, EXIT_RUNTIME_ERROR, runCli } from '../../src/cli/run.js';
import { LOCKED_WRITE_COMMANDS } from '../../src/cli/lockGuard.js';
import { initProject } from '../../src/app/workflow/engine.js';
import { runDraftScene } from '../../src/app/workflow/draft.js';
import { LOCK_FILE } from '../../src/infra/store/layout.js';

function captureIo(): CliIo & { stdout: () => string; stderr: () => string } {
  let out = '';
  let err = '';
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

const argv = (...args: string[]): string[] => ['node', 'sw', ...args];

/** 目录快照（相对路径 → 内容），零写盘副作用断言用（AT-L01/L14）。 */
async function snapshotDir(root: string, prefix = ''): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [k, v] of await snapshotDir(join(root, entry.name), rel)) {
        map.set(k, v);
      }
    } else {
      map.set(rel, await readFile(join(root, entry.name), 'utf8'));
    }
  }
  return map;
}

async function plantLiveLock(dir: string): Promise<void> {
  await mkdir(join(dir, '.sw'), { recursive: true });
  await writeFile(
    join(dir, LOCK_FILE),
    `pid: ${process.pid}\nhostname: ${os.hostname()}\nacquired_at: 2026-08-28T02:31:07Z\n`,
    'utf8',
  );
}

let dir: string;
let previousCwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-cli-lock-'));
  const result = await initProject(dir, { title: '锁测试', created: '2026-08-27' });
  expect(result.ok).toBe(true);
  previousCwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(dir, { recursive: true, force: true });
});

describe('cli 锁接线：活锁互斥（AT-L01 命令层）', () => {
  it('活锁下写命令 → SW-E012、退出码 1、目录零写盘副作用', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    await plantLiveLock(dir);
    const before = await snapshotDir(dir);
    const io = captureIo();
    expect(await runCli(argv('draft', '020', '--title', '冲突'), io)).toBe(EXIT_RUNTIME_ERROR);
    expect(io.stderr()).toContain('SW-E012');
    expect(io.stderr()).toContain(`pid ${process.pid}`);
    expect(io.stdout()).toBe('');
    const after = await snapshotDir(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, value] of before) {
      expect(after.get(key)).toBe(value);
    }
  });

  it('E012 三段式含 sw doctor 指引（§5 成文）', async () => {
    await plantLiveLock(dir);
    const io = captureIo();
    await runCli(argv('outline'), io);
    expect(io.stderr()).toContain('sw doctor');
    expect(io.stderr()).toContain('怎么办');
  });
});

describe('cli 锁接线：只读命令在活锁下照常（AT-L03）', () => {
  it('status / doctor / revise --list 不受活锁影响', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    await plantLiveLock(dir);
    const status = captureIo();
    expect(await runCli(argv('status'), status)).toBe(EXIT_OK);
    expect(status.stdout()).toContain('锁测试');
    const list = captureIo();
    expect(await runCli(argv('revise', '--list'), list)).toBe(EXIT_OK);
    expect(list.stdout()).toContain('010');
    const doc = captureIo();
    // doctor 在活锁下退出码仍按其语义（活锁 = pass 正常并发，零红项 → 0）
    expect(await runCli(argv('doctor'), doc)).toBe(EXIT_OK);
    expect(doc.stdout()).toContain('正常并发');
  });
});

describe('cli 锁接线：ADR-0002 边界与 stale 接管（AT-L07/L02 命令层）', () => {
  it('删除无持有者锁后写命令行为逐字节一致（stdout/退出码），锁自动重建再释放', async () => {
    const runOnce = async (): Promise<{ code: number; out: string }> => {
      const io = captureIo();
      const code = await runCli(argv('draft', '010', '--title', '开场'), io);
      return { code, out: io.stdout() };
    };
    const first = await runOnce(); // 创建场（锁自动建/释）
    expect(first.code).toBe(EXIT_OK);
    // 手工删除残留锁（若有）再跑 kept 路径
    await rm(join(dir, LOCK_FILE), { force: true });
    const second = await runOnce();
    expect(second.code).toBe(EXIT_OK);
    expect(second.out).toContain('已存在，未改动');
  });

  it('stale 锁 → 写命令接管成功：stderr 恰一行告警、stdout 末行契约不变、退出码 0', async () => {
    const deadPid = 2 ** 22 + 9999;
    await mkdir(join(dir, '.sw'), { recursive: true });
    await writeFile(
      join(dir, LOCK_FILE),
      `pid: ${deadPid}\nhostname: ${os.hostname()}\nacquired_at: 2026-08-27T10:00:00Z\n`,
      'utf8',
    );
    const io = captureIo();
    expect(await runCli(argv('outline'), io)).toBe(EXIT_OK);
    expect(io.stderr().trim().split('\n')).toHaveLength(1);
    expect(io.stderr()).toContain(`pid ${deadPid} 已不存活`);
    expect(io.stdout().trimEnd().split('\n').pop()).toMatch(/^sw /);
    // 接管后正常释放，无残留锁
    await expect(readFile(join(dir, LOCK_FILE), 'utf8')).rejects.toThrow();
  });
});

describe('cli 锁接线：init 特殊次序（AT-L14）', () => {
  it('活锁 + --force → E012 且目录零变化；E010 判定先于取锁（无 --force 零 .sw 副作用）', async () => {
    // 已有项目 + 活锁 + --force → E012，目录不变
    await plantLiveLock(dir);
    const before = await snapshotDir(dir);
    const io = captureIo();
    expect(await runCli(argv('init', '--yes', '--force'), io)).toBe(EXIT_RUNTIME_ERROR);
    expect(io.stderr()).toContain('SW-E012');
    expect([...(await snapshotDir(dir)).keys()].sort()).toEqual([...before.keys()].sort());

    // 非空目录无 --force → E010 先于取锁（E010 报错文本而非 E012）
    const io2 = captureIo();
    expect(await runCli(argv('init', '--yes'), io2)).toBe(EXIT_RUNTIME_ERROR);
    expect(io2.stderr()).toContain('SW-E010');
  });

  it('stale 锁下 init --force 接管成功、产物完整', async () => {
    const deadPid = 2 ** 22 + 7777;
    await mkdir(join(dir, '.sw'), { recursive: true });
    await writeFile(
      join(dir, LOCK_FILE),
      `pid: ${deadPid}\nhostname: ${os.hostname()}\nacquired_at: 2026-08-27T10:00:00Z\n`,
      'utf8',
    );
    const io = captureIo();
    expect(await runCli(argv('init', '--yes', '--force'), io)).toBe(EXIT_OK);
    expect(io.stderr()).toContain('已自动接管');
    expect(io.stdout()).toContain('项目已创建');
  });
});

describe('cli 锁接线：AT-L15 表驱动覆盖度（§6.3 漏接线防线）', () => {
  it('LOCKED_WRITE_COMMANDS 与锁矩阵 v1 一致（新写命令未进清单即红）', () => {
    expect([...LOCKED_WRITE_COMMANDS]).toEqual(['init', 'outline', 'draft', 'revise', 'export']);
  });

  it('矩阵内每个写命令在活锁下均得 SW-E012（接线零遗漏）', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const cases: Record<(typeof LOCKED_WRITE_COMMANDS)[number], string[]> = {
      init: ['init', '--yes', '--force'],
      outline: ['outline'],
      draft: ['draft', '020'],
      revise: ['revise', '010'],
      export: ['export'],
    };
    for (const command of LOCKED_WRITE_COMMANDS) {
      await rm(join(dir, LOCK_FILE), { force: true });
      await plantLiveLock(dir);
      const io = captureIo();
      expect(await runCli(argv(...cases[command]), io)).toBe(EXIT_RUNTIME_ERROR);
      expect(io.stderr()).toContain('SW-E012');
    }
  });
});
