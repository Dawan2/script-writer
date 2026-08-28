/**
 * `sw export` 接口层验收（SPEC-06 §5.4-⑩：help 含示例；别名 x；命令面退出码）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import type { CliIo } from '../../src/cli/io.js';
import { EXIT_OK, EXIT_RUNTIME_ERROR, runCli } from '../../src/cli/run.js';
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
  dir = await mkdtemp(join(tmpdir(), 'sw-cli-export-'));
  const result = await initProject(dir, { title: '我的短片', created: '2026-08-27' });
  expect(result.ok).toBe(true);
  previousCwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(dir, { recursive: true, force: true });
});

describe('cli/commands/export：注册、别名与帮助', () => {
  it('export 已注册且别名 x 生效（SPEC-07 挂载循环注入）', () => {
    const exported = buildProgram(captureIo()).commands.find((cmd) => cmd.name() === 'export');
    expect(exported).toBeDefined();
    expect(exported?.alias()).toBe('x');
  });

  it('export --help 含 ≥1 可复制示例与别名尾注（§5.4-⑩ + SPEC-07 §4.5）', () => {
    const program = buildProgram(captureIo());
    const exported = program.commands.find((cmd) => cmd.name() === 'export');
    let printed = '';
    exported?.exitOverride();
    exported?.configureOutput({
      writeOut: (str) => {
        printed += str;
      },
    });
    expect(() => exported?.parse(['node', 'sw', '--help'])).toThrow();
    expect(printed).toContain('示例');
    expect(printed).toContain('sw export');
    expect(printed).toContain('短别名：sw x ≡ sw export');
  });
});

describe('cli/commands/export：命令面行为', () => {
  it('导出路径 exit 0，stdout 末行 sw status', async () => {
    await runDraftScene(dir, '010', { title: '开场' });
    const io = captureIo();
    expect(await runCli(argv('export'), io)).toBe(EXIT_OK);
    const lines = io.stdout().trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('sw status');
  });

  it('空项目导出 → 退出码 1（SW-E034 三段式走 stderr）', async () => {
    const io = captureIo();
    expect(await runCli(argv('export'), io)).toBe(EXIT_RUNTIME_ERROR);
    expect(io.stderr()).toContain('SW-E034');
  });

  it('别名 x 与 export 逐字节等价（SPEC-07 §5-③）', async () => {
    const a = captureIo();
    const b = captureIo();
    expect(await runCli(argv('x', '--help'), a)).toBe(await runCli(argv('export', '--help'), b));
    expect(a.stdout()).toBe(b.stdout());
    expect(a.stderr()).toBe(b.stderr());
  });
});
