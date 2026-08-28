/**
 * `sw revise` 接口层验收（SPEC-04 验收 ⑤：help 含示例；别名 r；用法错误两例 → 退出码 2）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import type { CliIo } from '../../src/cli/io.js';
import { EXIT_OK, EXIT_USAGE_ERROR, runCli } from '../../src/cli/run.js';
import { initProject } from '../../src/app/workflow/engine.js';
import { runDraftScene } from '../../src/app/workflow/draft.js';

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

let dir: string;
let previousCwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-cli-revise-'));
  const result = await initProject(dir, { title: '我的短片', created: '2026-08-27' });
  expect(result.ok).toBe(true);
  previousCwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(dir, { recursive: true, force: true });
});

describe('cli/commands/revise：注册、别名与帮助', () => {
  it('revise 已注册且别名 r 生效（SPEC-07 挂载循环注入）', () => {
    const revise = buildProgram(captureIo()).commands.find((cmd) => cmd.name() === 'revise');
    expect(revise).toBeDefined();
    expect(revise?.alias()).toBe('r');
  });

  it('revise --help 含 ≥1 可复制示例与别名尾注（SPEC-04 验收 ⑤ + SPEC-07 §4.5）', () => {
    const program = buildProgram(captureIo());
    const revise = program.commands.find((cmd) => cmd.name() === 'revise');
    let printed = '';
    revise?.exitOverride();
    revise?.configureOutput({
      writeOut: (str) => {
        printed += str;
      },
    });
    expect(() => revise?.parse(['node', 'sw', '--help'])).toThrow();
    expect(printed).toContain('示例');
    expect(printed).toContain('sw revise 010');
    expect(printed).toContain('短别名：sw r ≡ sw revise');
  });
});

describe('cli/commands/revise：命令面行为', () => {
  it('清单路径 exit 0，stdout 末行可复制', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const io = captureIo();
    expect(await runCli(argv('revise'), io)).toBe(EXIT_OK);
    const lines = io.stdout().trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('sw revise 010');
  });

  it('--done 缺 <scene-id> → 退出码 2（用法错误）', async () => {
    const io = captureIo();
    expect(await runCli(argv('revise', '--done'), io)).toBe(EXIT_USAGE_ERROR);
  });

  it('--done 与 --list 互斥 → 退出码 2', async () => {
    const io = captureIo();
    expect(await runCli(argv('revise', '010', '--done', '--list'), io)).toBe(EXIT_USAGE_ERROR);
  });

  it('别名 r 与 revise 逐字节等价（SPEC-07 §5-③）', async () => {
    const a = captureIo();
    const b = captureIo();
    expect(await runCli(argv('r', '--help'), a)).toBe(await runCli(argv('revise', '--help'), b));
    expect(a.stdout()).toBe(b.stdout());
    expect(a.stderr()).toBe(b.stderr());
  });
});
