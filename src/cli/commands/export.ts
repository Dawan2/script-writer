/**
 * 接口层·sw export 子命令（SPEC-06，W3-DRAFT-T02）。
 * 只做参数接线与输出；失败经 fail()/failProject() 抛 SwError，由 runCli 顶层 catch
 * 统一渲染并映射退出码 1。
 */

import { Command } from 'commander';
import { runExport, type ExportOptions } from '../../app/workflow/export.js';
import { renderExportReport } from '../../app/workflow/exportReport.js';
import type { CliIo } from '../io.js';

const EXPORT_EXAMPLES = `
示例：
  $ sw export                          # 导出到 exports/<标题>.md（markdown v1）
  $ sw export --format md              # md ≡ markdown（归一别名）
  $ sw export --out dist/final.md      # 指定产物路径（父目录自动创建）
`;

/** 注册 export 子命令（经命令注册表挂载循环调用，别名 x 在 registry.ts 统一注入）。 */
export function registerExportCommand(program: Command, io: CliIo): void {
  program
    .command('export')
    .description('导出脚本为 markdown（聚合 outline.md 与 scenes/*.md；派生产物允许覆盖）')
    .option('--format <id>', '导出格式（v1 支持 markdown，别名 md）')
    .option('--out <path>', '产物文件路径（缺省 exports/<标题>.md；父目录自动创建）')
    .addHelpText('after', EXPORT_EXAMPLES)
    .action(async (options: ExportOptions) => {
      const outcome = await runExport(process.cwd(), options);
      io.out(`${renderExportReport(outcome).join('\n')}\n`);
    });
}
