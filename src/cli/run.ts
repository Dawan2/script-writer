/**
 * 接口层·CLI 运行器：SPEC-03 唯一渲染出口 + SPEC-03-EXT 退出码约定（W2-GAP-T06）。
 *
 * 退出码表（docs/wave-02/P-gap-adjudication.md §3.6，禁止自定义其他码）：
 *   0 成功（含幂等式「无事可做」）；
 *   1 运行期错误（任何经 fail() 输出的 SW-Exxx；亦含检查类命令发现问题）；
 *   2 用法错误（参数/旗标解析失败，未进入业务逻辑）。
 *
 * 落地方式：业务代码只 fail(code, ctx) 不碰 process.exit（ESLint 拦截）；
 * 本模块顶层 catch 统一渲染与映射；退出码只由 src/cli/main.ts 写入 process.exitCode。
 */

import { CommanderError } from 'commander';
import { isSwError } from '../app/errors/registry.js';
import { renderError, renderUnexpectedError } from '../app/errors/render.js';
import { buildProgram } from './program.js';

/** 成功（含幂等式「无事可做」的成功）。 */
export const EXIT_OK = 0;
/** 运行期错误（经 fail() 的 SW-Exxx / 检查类命令发现问题 / 裸异常兜底）。 */
export const EXIT_RUNTIME_ERROR = 1;
/** 用法错误（argparse 层解析失败，未进入业务逻辑）。 */
export const EXIT_USAGE_ERROR = 2;

export type ExitCode = typeof EXIT_OK | typeof EXIT_RUNTIME_ERROR | typeof EXIT_USAGE_ERROR;

/** 输出通道抽象：默认写 stdout/stderr；测试注入以捕获输出。 */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const processIo: CliIo = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

/**
 * 顶层 catch 的错误 → 退出码映射（SPEC-03-EXT 唯一实现点）。
 *
 * - CommanderError：exitCode 0（--help / --version 正常终止）→ 0；
 *   其余（未知旗标 / 未知命令 / 多余参数 / 缺参）都是 argparse 层用法错误 → 2。
 *   注：业务代码禁用 program.error()（会伪装成 CommanderError），错误一律走 fail()。
 * - SwError（fail() 唯一入口产出）：渲染三段式消息到 stderr → 1。
 * - 其他异常：裸异常兜底渲染 → 1。
 */
export function toExitCode(error: unknown, io: CliIo): ExitCode {
  if (error instanceof CommanderError) {
    // commander 在抛错前已通过 configureOutput 打印帮助/错误消息，此处只做码映射。
    return error.exitCode === 0 ? EXIT_OK : EXIT_USAGE_ERROR;
  }
  if (isSwError(error)) {
    io.err(`${renderError(error)}\n`);
    return EXIT_RUNTIME_ERROR;
  }
  io.err(`${renderUnexpectedError(error)}\n`);
  return EXIT_RUNTIME_ERROR;
}

/**
 * 运行 CLI 并返回退出码（不直接退出进程——process.exitCode 由 main.ts 设定，
 * 避免 process.exit 截断未刷完的输出流）。
 */
export async function runCli(argv: readonly string[], io: CliIo = processIo): Promise<ExitCode> {
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => {
      io.out(str);
    },
    writeErr: (str) => {
      io.err(str);
    },
  });
  try {
    await program.parseAsync([...argv]);
    return EXIT_OK;
  } catch (error) {
    return toExitCode(error, io);
  }
}
