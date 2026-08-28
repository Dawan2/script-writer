/**
 * 接口层·CLI 程序构建。
 * W1-P1-T04 起 `sw init` 可用、W1-P1-T05 起 `sw status`（最小版）可用、
 * W2-GAP-T02 起 `sw help` 可用；其余子命令仍标注"规划中"（注册表 planned 条目零注册，
 * 禁止虚假可用性承诺，见 W1-P1-T01 验收 ③）。
 *
 * SPEC-07（W4-HELP-T01）：子命令挂载、别名注入与 help 路线图全部自命令注册表
 * （src/cli/registry.ts）生成；手工 ROADMAP_HELP 字面量已退役（GAP-02「禁止手工清单」）。
 */

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { processIo, type CliIo } from './io.js';
import { COMMAND_REGISTRY, mountCommands } from './registry.js';
import { renderDefaultHelpTail } from './helpText.js';

interface PackageManifest {
  version: string;
  description: string;
}

function readManifest(): PackageManifest {
  // 相对本模块两级向上即仓库根（src/cli/ 与 dist/cli/ 深度一致）
  const url = new URL('../../package.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as PackageManifest;
}

export function buildProgram(io: CliIo = processIo): Command {
  const manifest = readManifest();
  const program = new Command();
  program
    .name('sw')
    .description(manifest.description)
    .version(manifest.version, '-V, --version', '输出版本号')
    .helpOption('-h, --help', '显示帮助')
    // 隐式 help 命令停用：显式注册表 aux 条目承载 help（否则 --all 无处挂载，SPEC-07 §4.4）
    .addHelpCommand(false)
    .addHelpText('after', renderDefaultHelpTail(COMMAND_REGISTRY))
    // 退出码由 run.ts 顶层统一裁定（SPEC-03-EXT）；输出走注入的 CliIo。
    // 两者须在注册子命令前设置，子命令创建时继承（commander copyInheritedSettings）。
    .exitOverride()
    .configureOutput({
      writeOut: (str) => {
        io.out(str);
      },
      writeErr: (str) => {
        io.err(str);
      },
    })
    // 渐进披露（SPEC-07 §4.3-2）：默认 help 清单只展示 main 组命令，
    // aux 组命令经 sw help --all 全集视图展示（数据同源自注册表）。
    .configureHelp({
      visibleCommands: (cmd) => {
        const auxNames = new Set(
          COMMAND_REGISTRY.filter((s) => s.group === 'aux').map((s) => s.name),
        );
        return cmd.commands.filter((c) => !auxNames.has(c.name()));
      },
    })
    .action(() => {
      // 无参数运行 = 输出帮助；待非项目目录也有引导后，
      // 按 P1 §6.4 切换为等价 sw status（切换点：本 action 改调 runStatus）
      program.outputHelp();
    });
  // 唯一挂载循环：注册 available 条目并统一注入别名与可见性尾注（SPEC-07 §4.1-1）
  mountCommands(program, io);
  return program;
}
