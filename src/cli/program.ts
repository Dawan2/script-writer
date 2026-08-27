/**
 * 接口层·CLI 程序构建。
 * W1-P1-T04 起 `sw init` 可用、W1-P1-T08 起 `sw doctor` 可用；其余子命令仍标注
 * "规划中"（禁止虚假可用性承诺，见 W1-P1-T01 验收 ③），随 W1-P1-T05 等任务逐步落地。
 */

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerInitCommand } from './commands/init.js';
import { processIo, type CliIo } from './io.js';

interface PackageManifest {
  version: string;
  description: string;
}

function readManifest(): PackageManifest {
  // 相对本模块两级向上即仓库根（src/cli/ 与 dist/cli/ 深度一致）
  const url = new URL('../../package.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as PackageManifest;
}

const ROADMAP_HELP = `
主工作流（五步，P1 方案 §6.2）：init → outline → draft → revise → export

子命令实现进度：
  sw init      初始化项目向导          [可用 · W1-P1-T04]
  sw doctor    环境与项目自检          [可用 · W1-P1-T08]
  sw status    显示进度与下一步命令    [规划中 · W1-P1-T05]
  sw outline   编辑大纲                [规划中 · W1-P1-T05]
  sw draft     起草/续写场景           [规划中 · W1-P1-T05]
  sw export    导出脚本                [规划中 · W1-P1-T05]

文档：https://github.com/Dawan2/script-writer/blob/main/docs/quickstart.md
`;

export function buildProgram(io: CliIo = processIo()): Command {
  const manifest = readManifest();
  const program = new Command();
  program
    .name('sw')
    .description(manifest.description)
    .version(manifest.version, '-V, --version', '输出版本号')
    .helpOption('-h, --help', '显示帮助')
    .addHelpText('after', ROADMAP_HELP)
    // 退出码由 run.ts 顶层统一裁定（GAP-06）；须在注册子命令前设置以便被继承。
    .exitOverride()
    .configureOutput({
      writeOut: (str) => {
        io.stdout.write(str);
      },
      writeErr: (str) => {
        io.stderr.write(str);
      },
    })
    .action(() => {
      // status 落地前，无参数运行 = 输出帮助（落地后按 P1 §6.4 改为等价 sw status）
      program.outputHelp();
    });

  registerInitCommand(program, io);
  registerDoctorCommand(program, io);
  return program;
}
