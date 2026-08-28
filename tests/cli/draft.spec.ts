/**
 * `sw draft` 接口层验收（SPEC-05 §4.5-⑦⑧：旗标互斥 → 2；help 含示例；别名 d）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import type { CliIo } from '../../src/cli/io.js';
import { EXIT_OK, EXIT_USAGE_ERROR, runCli } from '../../src/cli/run.js';
import { initProject } from '../../src/app/workflow/engine.js';

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
  dir = await mkdtemp(join(tmpdir(), 'sw-cli-draft-'));
  const result = await initProject(dir, { title: '我的短片', created: '2026-08-27' });
  expect(result.ok).toBe(true);
  previousCwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(previousCwd);
  await rm(dir, { recursive: true, force: true });
});

describe('cli/commands/draft：注册、别名与帮助', () => {
  it('draft 已注册且别名 d 生效（SPEC-07 挂载循环注入）', () => {
    const draft = buildProgram(captureIo()).commands.find((cmd) => cmd.name() === 'draft');
    expect(draft).toBeDefined();
    expect(draft?.alias()).toBe('d');
  });

  it('draft --help 含 ≥1 可复制示例与别名尾注（P1 §4 + SPEC-07 §4.5）', () => {
    const program = buildProgram(captureIo());
    const draft = program.commands.find((cmd) => cmd.name() === 'draft');
    let printed = '';
    draft?.exitOverride();
    draft?.configureOutput({
      writeOut: (str) => {
        printed += str;
      },
    });
    expect(() => draft?.parse(['node', 'sw', '--help'])).toThrow();
    expect(printed).toContain('示例');
    expect(printed).toContain('sw draft 010');
    expect(printed).toContain('短别名：sw d ≡ sw draft');
  });
});

describe('cli/commands/draft：命令面行为', () => {
  it('创建路径 exit 0，stdout 末行可复制', async () => {
    const io = captureIo();
    expect(await runCli(argv('draft', '010', '--title', '开场'), io)).toBe(EXIT_OK);
    const lines = io.stdout().trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('sw draft 010 --done');
  });

  it('--title 与 --done 互斥 → 退出码 2 且零副作用（§4.5-⑦）', async () => {
    const io = captureIo();
    expect(await runCli(argv('draft', '010', '--title', '开场', '--done'), io)).toBe(
      EXIT_USAGE_ERROR,
    );
    expect(io.stdout()).toBe('');
  });

  it('缺 <scene-id> → 退出码 2（argparse 层）', async () => {
    const io = captureIo();
    expect(await runCli(argv('draft'), io)).toBe(EXIT_USAGE_ERROR);
  });

  it('别名 d 与 draft 逐字节等价（已注册命令即时生效，SPEC-07 §5-③）', async () => {
    const a = captureIo();
    const b = captureIo();
    expect(await runCli(argv('d', '--help'), a)).toBe(await runCli(argv('draft', '--help'), b));
    expect(a.stdout()).toBe(b.stdout());
    expect(a.stderr()).toBe(b.stderr());
  });
});
