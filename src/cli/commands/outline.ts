/**
 * 接口层·sw outline 子命令（W1-P1-T07 最小版）。
 * 只做参数接线与输出，全部逻辑在应用层（outline.ts / outlineReport.ts）——保持接口可替换（P1 §5.1）。
 */

import type { Command } from 'commander';
import { ensureOutline } from '../../app/workflow/outline.js';
import { renderOutlineReport } from '../../app/workflow/outlineReport.js';
import { renderProjectFailure } from '../../app/workflow/statusReport.js';

export interface OutlineRunResult {
  exitCode: 0 | 1;
  lines: string[];
}

/** 纯执行体：CLI action 与测试共用（不直接读 process，便于注入任意目录）。 */
export async function runOutline(projectDir: string): Promise<OutlineRunResult> {
  const result = await ensureOutline(projectDir);
  if (!result.ok) {
    return { exitCode: 1, lines: renderProjectFailure(result) };
  }
  return { exitCode: 0, lines: renderOutlineReport(result) };
}

/** 注册 outline 子命令（program.ts 唯一挂载点，便于并行槽合并时最小冲突面）。 */
export function registerOutlineCommand(program: Command): void {
  program
    .command('outline')
    .description('创建/补齐大纲 outline.md（缺失或为空时写入当前脚本类型的模板骨架）')
    .addHelpText(
      'after',
      '\n示例：\n  cd my-story && sw outline   # outline.md 缺失/为空时写入模板骨架；已有内容则不覆盖\n',
    )
    .action(async () => {
      const { exitCode, lines } = await runOutline(process.cwd());
      const write = exitCode === 0 ? console.log : console.error;
      write(lines.join('\n'));
      process.exitCode = exitCode;
    });
}
