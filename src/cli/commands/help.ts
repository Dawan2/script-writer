/**
 * 接口层·`sw help [command] [--all]` 子命令（SPEC-07 §4.4，W2-GAP-T02 使能）。
 *
 * 与 --help 同一渲染出口（逐字节等价）；--all 展示注册表全集视图。
 * 退出码全集只有 0/2 两档：成功输出 → 0；用法错误（未知词条 / --all 与 <command>
 * 互斥违反）→ 2，经 CommanderError 通道由 runCli 统一映射。零状态写入、不读
 * project.yaml、非项目目录可运行（§4.6）。help 不设别名与短旗标（§4.4 原文）。
 */

import { CommanderError, type Command } from 'commander';
import { renderAllHelp } from '../helpText.js';
import type { CliIo } from '../io.js';
import type { CommandSpec } from '../registry.js';

interface HelpCliOptions {
  all?: boolean;
}

/** 用法错误：先经注入的 CliIo 打印错误消息，再抛 CommanderError（runCli 映射退出码 2）。 */
function usageError(io: CliIo, message: string): never {
  io.err(`错误：${message}\n`);
  throw new CommanderError(2, 'commander.helpUsageError', message);
}

export function registerHelpCommand(
  program: Command,
  io: CliIo,
  registry: readonly CommandSpec[],
): void {
  program
    .command('help')
    .description('显示帮助（--all 查看全部命令与别名）')
    .argument('[command]', '命令名或别名（缺省 = sw --help）')
    .option('--all', '显示全部命令与别名（含规划中）')
    .addHelpText('after', '\n示例：\n  $ sw help            # 等同 sw --help\n  $ sw help status     # 等同 sw status --help\n  $ sw help --all      # 全部命令与别名\n')
    .action((commandArg: string | undefined, options: HelpCliOptions) => {
      if (commandArg !== undefined && options.all === true) {
        usageError(io, '--all 与 <command> 互斥：请只使用其中一个。');
      }
      if (options.all === true) {
        io.out(renderAllHelp(registry));
        return;
      }
      if (commandArg === undefined) {
        // sw help ≡ sw --help（同一渲染出口）
        program.outputHelp();
        return;
      }
      const target = program.commands.find(
        (c) => c.name() === commandArg || c.alias() === commandArg,
      );
      if (target === undefined) {
        usageError(io, `未知命令或别名 "${commandArg}"。运行 sw help --all 查看全部命令。`);
      }
      // sw help <command> ≡ sw <command> --help（逐字节等价）
      target.outputHelp();
    });
}
