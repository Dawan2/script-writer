/**
 * 接口层·sw revise 子命令（SPEC-04 + W3 规格 §6，W2-GAP-T01）。
 * --done 须与 <scene-id> 同给（缺 id 为用法错误 → 退出码 2）；--done 与 --list 互斥
 * （commander conflicts → 退出码 2）。失败经 fail()/failProject() 抛 SwError 走顶层 catch。
 */

import { Command, CommanderError, Option } from 'commander';
import { runRevise, type ReviseOptions } from '../../app/workflow/revise.js';
import { renderReviseReport } from '../../app/workflow/reviseReport.js';
import type { CliIo } from '../io.js';

const REVISE_EXAMPLES = `
示例：
  $ sw revise                # 修订清单 + 建议下一场（并把步骤推进到 revise）
  $ sw revise --list         # 纯只读清单（供脚本/CI 消费，不写任何文件）
  $ sw revise 010            # 打开场 010 进入修订
  $ sw revise 010 --done     # 修订完成后标记本场已修订（幂等）
`;

/** 注册 revise 子命令（经命令注册表挂载循环调用，别名 r 在 registry.ts 统一注入）。 */
export function registerReviseCommand(program: Command, io: CliIo): void {
  program
    .command('revise')
    .description('修订场景：清单/打开/标记已修订（不创建场，创建用 sw draft）')
    .argument('[scene-id]', '场编号（如 010；缺省 = 输出修订清单）')
    .addOption(new Option('--done', '把该场标记为已修订（幂等）').conflicts(['list']))
    .option('--list', '只读输出修订清单（零写盘）')
    .addHelpText('after', REVISE_EXAMPLES)
    .action(async (sceneId: string | undefined, options: ReviseOptions) => {
      if (options.done === true && sceneId === undefined) {
        io.err('错误：--done 需要指定场编号，如 `sw revise 010 --done`。\n');
        throw new CommanderError(2, 'commander.reviseUsageError', '--done 缺 <scene-id>');
      }
      const outcome = await runRevise(process.cwd(), sceneId, options);
      io.out(`${renderReviseReport(outcome).join('\n')}\n`);
    });
}
