/**
 * 接口层·`sw init` 子命令（SPEC-01，W1-P1-T04）。
 *
 * 职责：旗标解析（用法错误由 commander 抛出 → 退出码 2，GAP-06）、readline 交互适配
 * （EOF 视为接受默认值，管道/CI 友好）、成功摘要渲染。向导编排在 src/app/workflow/init.ts。
 */

import readline from 'node:readline/promises';
import path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { SCRIPT_FORMATS, type ScriptFormat } from '../../core/model/project.js';
import { OUTLINE_FILE } from '../../infra/store/layout.js';
import { runInitWorkflow, type InitFlags, type InitResult } from '../../app/workflow/init.js';
import type { CliIo } from '../io.js';

const INIT_EXAMPLES = `
示例：
  $ sw init my-story                # 交互向导（≤ 4 问，回车接受默认值）
  $ sw init my-story --yes          # 非交互：全部采用默认值（CI/脚本友好）
  $ sw init my-story --title "我的短片" --format short-video --scenes 5 --no-ai
`;

function parseScenesFlag(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new InvalidArgumentError('预计场数必须是正整数。');
  }
  return Number(value);
}

interface InitCliOptions {
  template?: string;
  yes?: boolean;
  title?: string;
  format?: ScriptFormat;
  scenes?: number;
  ai?: boolean;
  force?: boolean;
}

/**
 * readline 适配：创建时即挂 'line' 监听做行缓冲（管道输入先于提问到达也不丢答案），
 * EOF（输入流关闭）后的所有提问返回 ''，即接受默认值——管道/CI 场景不挂起。
 */
function createAsk(io: CliIo): { ask: (question: string) => Promise<string>; dispose: () => void } {
  const rl = readline.createInterface({ input: io.stdin, output: io.stdout });
  const buffered: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) {
      waiter('');
    }
  });
  return {
    ask: (question) => {
      io.stdout.write(question);
      const line = buffered.shift();
      if (line !== undefined) {
        return Promise.resolve(line);
      }
      if (closed) {
        return Promise.resolve('');
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    dispose: () => rl.close(),
  };
}

function renderSummary(result: InitResult, dirArg: string | undefined): string {
  const { meta } = result;
  const projectPath = dirArg ?? result.dir;
  const lines = [
    `✔ 项目已创建：${result.dir}`,
    `  标题：${meta.title} ｜ 类型：${meta.format} ｜ 预计场数：${meta.expectedSceneCount} ｜ AI 辅助：${meta.settings.ai.enabled ? '开' : '关'}`,
    `  模板：${result.templateId}` +
      (result.templateFallback ? `（${meta.format} 专属模板随 W1-P1-T07 交付，暂用通用骨架）` : ''),
    '  产出：project.yaml、outline.md、.gitignore、characters/、scenes/、exports/',
    // TODO(W1-P1-T05)：`sw status` / `sw outline` 落地后，末行改为可直接执行的 `sw status`（SPEC-01 原文）。
    `  下一步：编辑 ${path.join(projectPath, OUTLINE_FILE)} 写大纲（\`sw status\` 引导随 W1-P1-T05 交付）`,
  ];
  return lines.join('\n');
}

export function registerInitCommand(program: Command, io: CliIo): void {
  program
    .command('init')
    .description('初始化项目向导（≤ 4 问；--yes 非交互全默认）')
    .argument('[dir]', '目标目录（缺省：当前目录）')
    .option('--template <id>', '模板 id（缺省跟随脚本类型；专属模板未内置时回退通用骨架）')
    .option('-y, --yes', '非交互：全部问题采用默认值')
    .option('--title <title>', '项目标题（提供则跳过第 ① 问）')
    .addOption(
      new Option('--format <format>', '脚本类型（提供则跳过第 ② 问）').choices(SCRIPT_FORMATS),
    )
    .option('--scenes <count>', '预计场数（提供则跳过第 ③ 问）', parseScenesFlag)
    .option('--ai', '启用 AI 辅助（提供则跳过第 ④ 问）')
    .option('--no-ai', '不启用 AI 辅助（提供则跳过第 ④ 问）')
    .option('--force', '目标目录非空时仍初始化：覆盖同名脚手架文件，保留其余文件')
    .addHelpText('after', INIT_EXAMPLES)
    .action(async (dir: string | undefined, options: InitCliOptions) => {
      const flags: InitFlags = {
        template: options.template,
        yes: options.yes,
        title: options.title,
        format: options.format,
        scenes: options.scenes,
        ai: options.ai,
        force: options.force,
      };
      const { ask, dispose } = createAsk(io);
      try {
        const result = await runInitWorkflow(dir, flags, {
          ask,
          info: (line) => io.stdout.write(`${line}\n`),
          today: () => new Date().toISOString().slice(0, 10),
        });
        io.stdout.write(`${renderSummary(result, dir)}\n`);
      } finally {
        dispose();
      }
    });
}
