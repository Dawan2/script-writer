import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { runStatus } from '../../src/cli/commands/status.js';
import { initProject, markSceneDone } from '../../src/app/workflow/engine.js';
import { isSwError, type SwError } from '../../src/app/errors/registry.js';
import { renderError } from '../../src/app/errors/render.js';
import { EXIT_OK, EXIT_RUNTIME_ERROR, runCli, type CliIo } from '../../src/cli/run.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-cli-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

describe('cli/commands/status：注册与帮助', () => {
  it('status 子命令已注册到 sw（W1-P1-T05 最小版落地）', () => {
    const names = buildProgram().commands.map((cmd) => cmd.name());
    expect(names).toContain('status');
  });

  it('status --help 含 ≥1 个可复制示例（P1 §4 命令可发现性指标）', () => {
    const program = buildProgram();
    const status = program.commands.find((cmd) => cmd.name() === 'status');
    expect(status).toBeDefined();
    const help = status?.helpInformation() ?? '';
    // helpInformation 不含 addHelpText 附加段，示例断言走 parse 捕获
    let printed = '';
    status?.exitOverride();
    status?.configureOutput({
      writeOut: (str) => {
        printed += str;
      },
    });
    expect(() => status?.parse(['node', 'sw', '--help'])).toThrow();
    expect(printed).toContain('示例');
    expect(printed).toContain('sw status');
    expect(help).toContain('显示项目进度');
  });

  it('主程序 --help 中 status 标注为可用而非规划中', () => {
    let printed = '';
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({
      writeOut: (str) => {
        printed += str;
      },
    });
    expect(() => program.parse(['node', 'sw', '--help'])).toThrow();
    const statusLine = printed.split('\n').find((line) => line.includes('sw status'));
    expect(statusLine).toContain('可用');
    expect(statusLine).not.toContain('规划中');
  });
});

describe('cli/commands/status：执行体（引擎接线，W3 集成后失败走 fail() 通道）', () => {
  it('项目目录内：返回渲染行，末行为可复制的下一步命令（SPEC-02 验收要点）', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    await markSceneDone(dir, '010');
    const lines = await runStatus(dir);
    const text = lines.join('\n');
    expect(text).toContain('我的短片');
    expect(text).toContain('场已完成');
    const last = lines[lines.length - 1];
    expect(last?.startsWith('sw ')).toBe(true);
    expect(last).not.toContain('<');
  });

  it('非项目目录：抛 SW-E011（SwError），渲染为三段式引导（原 exit 1 语义由 runCli 统一映射）', async () => {
    try {
      await runStatus(dir);
      expect.unreachable('非项目目录必须抛 SwError');
    } catch (error) {
      expect(isSwError(error)).toBe(true);
      const swError = error as SwError<'SW-E011'>;
      expect(swError.code).toBe('SW-E011');
      const text = renderError(swError);
      expect(text).toContain('SW-E011');
      expect(text).toContain('怎么办');
      expect(text).toContain(dir);
    }
  });

  it('中断恢复：连续两次 runStatus 输出一致（状态只源于磁盘，无进程内隐藏状态）', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    await markSceneDone(dir, '010');
    const first = await runStatus(dir);
    const second = await runStatus(dir);
    expect(second).toEqual(first);
  });
});

describe('cli/commands/status：退出码通道（语义冲突 ① 核销——命令层不触碰 process.exitCode）', () => {
  it('sw status 于项目目录 → runCli 返回 0，报告写入注入 io 的 stdout', async () => {
    await initProject(dir, { title: '我的短片', created: '2026-08-27' });
    const io = captureIo();
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await runCli(['node', 'sw', 'status'], io)).toBe(EXIT_OK);
    } finally {
      process.chdir(previousCwd);
    }
    expect(io.stdout()).toContain('我的短片');
    expect(io.stderr()).toBe('');
  });

  it('sw status 于非项目目录 → runCli 返回 1，stderr 为 SW-E011 三段式 + 锚点', async () => {
    const io = captureIo();
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await runCli(['node', 'sw', 'status'], io)).toBe(EXIT_RUNTIME_ERROR);
    } finally {
      process.chdir(previousCwd);
    }
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toContain('✖ SW-E011');
    expect(io.stderr()).toContain('原因：');
    expect(io.stderr()).toContain('怎么办：');
    expect(io.stderr()).toContain('docs/errors/SW-E011.md');
  });
});
