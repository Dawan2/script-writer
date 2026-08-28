/**
 * 接口层·sw draft 子命令（SPEC-05，W3-DRAFT-T01）。
 * 只做参数接线与输出；--title 与 --done 互斥属 argparse 层（commander conflicts → 退出码 2）。
 * 失败经 fail()/failProject() 抛 SwError，由 runCli 顶层 catch 统一渲染并映射退出码 1。
 */

import { Command, Option } from 'commander';
import { runDraftScene, type DraftOptions } from '../../app/workflow/draft.js';
import { renderDraftReport } from '../../app/workflow/draftReport.js';
import type { CliIo } from '../io.js';

const DRAFT_EXAMPLES = `
示例：
  $ sw draft 010 --title "开场"   # 创建第一场骨架（outline 缺失时顺手补齐）
  $ sw draft 010 --done           # 写完后标记完成（幂等）
  $ sw draft 10                   # 等同 sw draft 010（编号自动补零）
`;

/** 注册 draft 子命令（经命令注册表挂载循环调用，别名 d 在 registry.ts 统一注入）。 */
export function registerDraftCommand(program: Command, io: CliIo): void {
  program
    .command('draft')
    .description('创建/续写场景文件（scenes/<编号>-<名>.md）；--done 标记完成')
    .argument('<scene-id>', '场编号（如 010；1–3 位数字自动补零）')
    .option('--title <title>', '场标题（仅创建时消费；场已存在时不改名）')
    .addOption(new Option('--done', '把该场标记为已完成（幂等）').conflicts(['title']))
    .addHelpText('after', DRAFT_EXAMPLES)
    .action(async (sceneId: string, options: DraftOptions) => {
      const outcome = await runDraftScene(process.cwd(), sceneId, options);
      io.out(`${renderDraftReport(outcome).join('\n')}\n`);
    });
}
