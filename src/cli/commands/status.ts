/**
 * 接口层·sw status 子命令（W1-P1-T05 最小版，W3 集成适配）。
 * 只做参数接线与输出，全部逻辑在应用层引擎/渲染层——保持接口可替换（P1 §5.1）。
 *
 * 退出码通道（语义冲突 ① 核销）：本层不触碰 process.exitCode——
 * 失败经 failProject() 抛 SwError，由 runCli 顶层 catch 统一渲染并映射退出码 1
 * （SPEC-03-EXT「检查类命令发现问题 → 1」）；成功输出经注入的 CliIo 写 stdout。
 */

import type { Command } from 'commander';
import { readStatus } from '../../app/workflow/engine.js';
import { failProject, renderStatusReport } from '../../app/workflow/statusReport.js';
import type { CliIo } from '../io.js';

/**
 * 纯执行体：CLI action 与测试共用（不直接读 process，便于注入任意目录）。
 * 成功返回渲染行；失败抛 SwError（SW-E011/E020/E021/E022），不返回退出码——
 * 码由 runCli 统一映射。
 */
export async function runStatus(projectDir: string): Promise<string[]> {
  const result = await readStatus(projectDir);
  if (!result.ok) {
    failProject(result, projectDir);
  }
  return renderStatusReport(result.status);
}

/** 注册 status 子命令（program.ts 唯一挂载点，便于并行槽合并时最小冲突面）。 */
export function registerStatusCommand(program: Command, io: CliIo): void {
  program
    .command('status')
    .description('显示项目进度与下一步命令（在项目目录内运行）')
    .addHelpText(
      'after',
      '\n示例：\n  cd my-story && sw status   # 输出末行即可复制执行的下一步命令\n',
    )
    .action(async () => {
      const lines = await runStatus(process.cwd());
      io.out(`${lines.join('\n')}\n`);
    });
}
