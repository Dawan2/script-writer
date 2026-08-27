import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_REGISTRY, SwError } from '../../src/app/errors/registry.js';
import type { CliIo } from '../../src/cli/run.js';
import {
  EXIT_OK,
  EXIT_RUNTIME_ERROR,
  EXIT_USAGE_ERROR,
  runCli,
  toExitCode,
} from '../../src/cli/run.js';

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

describe('cli/run：退出码常量（SPEC-03-EXT 三档表回归锁，勘误前禁止改动）', () => {
  it('0 成功 / 1 运行期错误 / 2 用法错误', () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_RUNTIME_ERROR).toBe(1);
    expect(EXIT_USAGE_ERROR).toBe(2);
  });
});

describe('cli/run：成功路径 → 0', () => {
  it('--help → 0，且帮助（五步路线图）写入 stdout', async () => {
    const io = captureIo();
    expect(await runCli(argv('--help'), io)).toBe(EXIT_OK);
    expect(io.stdout()).toContain('init → outline → draft → revise → export');
    expect(io.stderr()).toBe('');
  });

  it('--version → 0，输出版本号', async () => {
    const io = captureIo();
    expect(await runCli(argv('--version'), io)).toBe(EXIT_OK);
    expect(io.stdout()).toMatch(/\d+\.\d+\.\d+/);
  });

  it('无参数运行 = 输出帮助，退出码 0', async () => {
    const io = captureIo();
    expect(await runCli(argv(), io)).toBe(EXIT_OK);
    expect(io.stdout()).toContain('主工作流');
  });
});

describe('cli/run：用法错误 → 2（argparse 层，未进入业务逻辑）', () => {
  it('未知旗标 → 2，错误消息写入 stderr', async () => {
    const io = captureIo();
    expect(await runCli(argv('--no-such-flag'), io)).toBe(EXIT_USAGE_ERROR);
    expect(io.stderr()).toContain('--no-such-flag');
  });

  it('未知旗标不触发业务副作用（stdout 无任何业务输出，W2-GAP-T06 验收 ②）', async () => {
    const io = captureIo();
    await runCli(argv('--no-such-flag'), io);
    expect(io.stdout()).toBe('');
  });

  it('未知命令（多余参数）→ 2', async () => {
    const io = captureIo();
    expect(await runCli(argv('no-such-command'), io)).toBe(EXIT_USAGE_ERROR);
    expect(io.stderr()).not.toBe('');
  });
});

describe('cli/run：运行期错误 → 1（顶层 catch 唯一渲染出口）', () => {
  it.each(ERROR_CODES)(
    '%s 经 fail() 抛出后：退出码 1，stderr 为三段式 + 锚点（W2-GAP-T06 验收 ①）',
    (code) => {
      const io = captureIo();
      const error = new SwError(code, ERROR_REGISTRY[code].example);
      expect(toExitCode(error, io)).toBe(EXIT_RUNTIME_ERROR);
      const stderr = io.stderr();
      expect(stderr).toContain(`✖ ${code}`);
      expect(stderr).toContain('原因：');
      expect(stderr).toContain('怎么办：');
      expect(stderr).toContain(`docs/errors/${code}.md`);
    },
  );

  it('裸异常（未经 fail）兜底：退出码仍为 1，渲染为可上报形态', () => {
    const io = captureIo();
    expect(toExitCode(new Error('实现缺陷示例'), io)).toBe(EXIT_RUNTIME_ERROR);
    expect(io.stderr()).toContain('未预期的内部错误');
    expect(io.stderr()).toContain('实现缺陷示例');
  });
});

describe('cli/run：CommanderError 映射（正常终止 vs 用法错误）', () => {
  it('exitCode 0（--help/--version 正常终止）→ 0', () => {
    const io = captureIo();
    const normal = new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)');
    expect(toExitCode(normal, io)).toBe(EXIT_OK);
    expect(io.stderr()).toBe('');
  });

  it('exitCode 非 0（commander 默认 1）统一映射为用法错误 2，不透传', () => {
    const io = captureIo();
    const usage = new CommanderError(1, 'commander.unknownOption', "error: unknown option '--x'");
    expect(toExitCode(usage, io)).toBe(EXIT_USAGE_ERROR);
  });
});
