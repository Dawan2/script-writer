/**
 * 接口层·sw status 子命令（W1-P1-T05 最小版）。
 * 只做参数接线与输出，全部逻辑在应用层引擎/渲染层——保持接口可替换（P1 §5.1）。
 */

import type { Command } from 'commander';
import { readStatus } from '../../app/workflow/engine.js';
import { renderProjectFailure, renderStatusReport } from '../../app/workflow/statusReport.js';

export interface StatusRunResult {
  exitCode: 0 | 1;
  lines: string[];
}

/** 纯执行体：CLI action 与测试共用（不直接读 process，便于注入任意目录）。 */
export async function runStatus(projectDir: string): Promise<StatusRunResult> {
  const result = await readStatus(projectDir);
  if (!result.ok) {
    return { exitCode: 1, lines: renderProjectFailure(result) };
  }
  return { exitCode: 0, lines: renderStatusReport(result.status) };
}

/** 注册 status 子命令（program.ts 唯一挂载点，便于并行槽合并时最小冲突面）。 */
export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('显示项目进度与下一步命令（在项目目录内运行）')
    .addHelpText(
      'after',
      '\n示例：\n  cd my-story && sw status   # 输出末行即可复制执行的下一步命令\n',
    )
    .action(async () => {
      const { exitCode, lines } = await runStatus(process.cwd());
      const write = exitCode === 0 ? console.log : console.error;
      write(lines.join('\n'));
      process.exitCode = exitCode;
    });
}
