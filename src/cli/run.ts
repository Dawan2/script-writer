/**
 * 接口层·顶层运行器：唯一的退出码裁定点（W2 GAP-06 / SPEC-03-EXT）。
 *
 * 退出码约定：0 = 成功；1 = 运行期错误（SW-Exxx，经三段式渲染）；
 * 2 = 用法错误（commander 解析层，未进入业务逻辑）。
 * 业务代码只 throw 不碰 process.exit；本模块也只返回码，由 main.ts 赋给 process.exitCode。
 */

import { CommanderError } from 'commander';
import { SwError, renderSwError } from '../app/errors/sw-error.js';
import { buildProgram } from './program.js';
import { processIo, type CliIo } from './io.js';

export async function runCli(argv: string[], io: CliIo = processIo()): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help / --version 属正常终止（exitCode 0）；其余解析层错误一律用法错误 = 2。
      if (error.code === 'commander.version' || error.code.startsWith('commander.help')) {
        return error.exitCode;
      }
      return 2;
    }
    if (error instanceof SwError) {
      io.stderr.write(`${renderSwError(error)}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`✖ 未预期错误：${message}\n`);
    return 1;
  }
}
