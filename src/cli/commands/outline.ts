/**
 * 接口层·sw outline 子命令（W1-P1-T07 最小版，W4 实现槽适配统一 IO 与错误框架）。
 * 只做参数接线与输出，全部逻辑在应用层（outline.ts / outlineReport.ts）——保持接口可替换（P1 §5.1）。
 *
 * 退出码通道（对齐 status 先例）：本层不触碰 process.exitCode——失败经 failProject()
 * 抛 SwError，由 runCli 顶层 catch 统一渲染并映射退出码 1；成功输出经注入的 CliIo。
 */

import type { Command } from 'commander';
import { ensureOutline } from '../../app/workflow/outline.js';
import { renderOutlineReport } from '../../app/workflow/outlineReport.js';
import { failProject } from '../../app/workflow/statusReport.js';
import type { CliIo } from '../io.js';

/** 纯执行体：CLI action 与测试共用。成功返回渲染行；失败抛 SwError（SW-E011/E020/E021/E022）。 */
export async function runOutline(projectDir: string): Promise<string[]> {
  const result = await ensureOutline(projectDir);
  if (!result.ok) {
    failProject(result, projectDir);
  }
  return renderOutlineReport(result);
}

/** 注册 outline 子命令（经命令注册表挂载循环调用，别名注入在 registry.ts 统一完成）。 */
export function registerOutlineCommand(program: Command, io: CliIo): void {
  program
    .command('outline')
    .description('创建/补齐大纲 outline.md（缺失或为空时写入当前脚本类型的模板骨架）')
    .addHelpText(
      'after',
      '\n示例：\n  cd my-story && sw outline   # outline.md 缺失/为空时写入模板骨架；已有内容则不覆盖\n',
    )
    .action(async () => {
      const lines = await runOutline(process.cwd());
      io.out(`${lines.join('\n')}\n`);
    });
}
