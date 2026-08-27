/**
 * 接口层·CLI 程序构建（入口打通版，W1-P1-T03 验收 ③）。
 * 本槽只交付 --help / --version 与诚实的"规划中"路线图；
 * 五步子命令由 W1-P1-T04/T05 落地（禁止虚假可用性承诺，见 W1-P1-T01 验收 ③）。
 */

import { readFileSync } from 'node:fs';
import { Command } from 'commander';

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
  sw init      初始化项目向导          [规划中 · W1-P1-T04]
  sw status    显示进度与下一步命令    [规划中 · W1-P1-T05]
  sw outline   编辑大纲                [规划中 · W1-P1-T05]
  sw draft     起草/续写场景           [规划中 · W1-P1-T05]
  sw export    导出脚本                [规划中 · W1-P1-T05]

文档：https://github.com/Dawan2/script-writer/blob/main/docs/quickstart.md
`;

export function buildProgram(): Command {
  const manifest = readManifest();
  const program = new Command();
  program
    .name('sw')
    .description(manifest.description)
    .version(manifest.version, '-V, --version', '输出版本号')
    .helpOption('-h, --help', '显示帮助')
    .addHelpText('after', ROADMAP_HELP)
    .action(() => {
      // 子命令落地前，无参数运行 = 输出帮助（落地后按 P1 §6.4 改为等价 sw status）
      program.outputHelp();
    });
  return program;
}
