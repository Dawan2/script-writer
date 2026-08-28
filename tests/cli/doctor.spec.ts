/**
 * `sw doctor` 接口层验收（W1-P1-T08 验收 ③：退出码 0/1；help 含示例；红项聚合 SW-E014）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import type { CliIo } from '../../src/cli/io.js';
import { EXIT_OK, EXIT_RUNTIME_ERROR, runCli } from '../../src/cli/run.js';
import { initProject } from '../../src/app/workflow/engine.js';
import { writeOutlineFile } from '../../src/infra/store/outlineFile.js';

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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-cli-doctor-'));
  const result = await initProject(dir, { title: '自检片', created: '2026-08-27' });
  expect(result.ok).toBe(true);
  await writeOutlineFile(dir, '# 大纲\n010 开场\n');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('cli/commands/doctor：注册与帮助', () => {
  it('doctor 已注册（aux 组，无别名——SPEC-07 别名表不预占）', () => {
    const doctor = buildProgram(captureIo()).commands.find((cmd) => cmd.name() === 'doctor');
    expect(doctor).toBeDefined();
    expect(doctor?.alias()).toBeUndefined();
  });

  it('doctor --help 含 ≥1 可复制示例与退出码说明（W1-P1-T10 快照面）', () => {
    const program = buildProgram(captureIo());
    const doctor = program.commands.find((cmd) => cmd.name() === 'doctor');
    let printed = '';
    doctor?.exitOverride();
    doctor?.configureOutput({
      writeOut: (str) => {
        printed += str;
      },
    });
    expect(() => doctor?.parse(['node', 'sw', '--help'])).toThrow();
    expect(printed).toContain('示例');
    expect(printed).toContain('sw doctor');
    expect(printed).toContain('退出码');
  });
});

describe('cli/commands/doctor：退出码裁定（GAP-06）', () => {
  it('健康项目 → 报告全绿、退出码 0', async () => {
    const io = captureIo();
    expect(await runCli(argv('doctor', dir), io)).toBe(EXIT_OK);
    expect(io.stdout()).toContain('未发现需要处理的问题');
    expect(io.stdout()).toContain('✔');
    expect(io.stderr()).toBe('');
  });

  it('损坏项目（删 project.yaml）→ 红项 + 修复命令，退出码 1，stderr 三段式 SW-E014', async () => {
    await rm(join(dir, 'project.yaml'));
    const io = captureIo();
    expect(await runCli(argv('doctor', dir), io)).toBe(EXIT_RUNTIME_ERROR);
    expect(io.stdout()).toContain('✖ 项目文件');
    expect(io.stdout()).toContain('修复：');
    expect(io.stderr()).toContain('SW-E014');
    expect(io.stderr()).toContain('怎么办');
  });

  it('非项目目录 → 报告完整产出不崩溃、退出码 1', async () => {
    const io = captureIo();
    expect(await runCli(argv('doctor', join(dir, '..')), io)).toBe(EXIT_RUNTIME_ERROR);
    expect(io.stdout()).toContain('项目自检');
    expect(io.stdout()).toContain('✖ 项目文件');
  });
});
