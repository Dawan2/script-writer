/**
 * 接口层·`sw init` 子命令（SPEC-01，W1-P1-T04；W3 集成适配统一 IO）。
 *
 * 职责：旗标解析（用法错误由 commander 抛出 → 退出码 2，SPEC-03-EXT）、readline 交互适配
 * （EOF 视为接受默认值，管道/CI 友好）、成功摘要渲染。向导编排在 src/app/workflow/init.ts。
 * 交互输入取 `io.stdin ?? process.stdin`（语义冲突 ⑦：单一 CliIo 抽象的交互扩展成员）。
 */

import readline from 'node:readline/promises';
import { resolve } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { SCRIPT_FORMATS, type ScriptFormat } from '../../core/model/project.js';
import { runInitWorkflow, type InitFlags, type InitResult } from '../../app/workflow/init.js';
import { inspectDir } from '../../infra/store/projectFile.js';
import { withProjectLock } from '../../infra/store/lock.js';
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
  // 提问文本由 io.out 输出（readline 只负责读行），保证测试注入即可捕获全部输出。
  const rl = readline.createInterface({ input: io.stdin ?? process.stdin });
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
      io.out(question);
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
  // W3 集成：`sw status` 已可用（W1-P1-T05 最小版并入），末行按 SPEC-01 原文
  // 改为可直接复制执行的下一步命令（不含 <占位符>；路径含空白时加引号保持可复制）。
  const nextCommand =
    dirArg === undefined
      ? 'sw status'
      : `cd ${/\s/.test(dirArg) ? JSON.stringify(dirArg) : dirArg} && sw status`;
  const lines = [
    `✔ 项目已创建：${result.dir}`,
    `  标题：${meta.title} ｜ 类型：${meta.format} ｜ 预计场数：${meta.expectedSceneCount} ｜ AI 辅助：${meta.settings.ai.enabled ? '开' : '关'}`,
    `  模板：${result.templateId}` +
      (result.templateFallback ? `（${meta.format} 专属模板随 W1-P1-T07 交付，暂用通用骨架）` : ''),
    '  产出：project.yaml、outline.md、.gitignore、characters/、scenes/、exports/',
    '  下一步（可直接复制执行）：',
    nextCommand,
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
        const runBody = async (extra?: Pick<InitFlags, 'prelocked'>) => {
          const result = await runInitWorkflow(dir, { ...flags, ...extra }, {
            ask,
            info: (line) => {
              io.out(`${line}\n`);
            },
            today: () => new Date().toISOString().slice(0, 10),
          });
          io.out(`${renderSummary(result, dir)}\n`);
        };
        // SPEC-07 §6.2 init 特殊次序：E013（目标是文件）/E010（非空且无 --force）判定
        // 先于取锁——先建 .sw/lock 会把空目录变非空、自我否决；失败形态零 .sw/ 副作用。
        const dirState = await inspectDir(resolve(dir ?? '.'));
        if (dirState === 'file' || (dirState === 'non-empty' && options.force !== true)) {
          await runBody();
        } else {
          await withProjectLock(
            resolve(dir ?? '.'),
            () => runBody({ prelocked: true }),
            (line) => io.err(line),
          );
        }
      } finally {
        dispose();
      }
    });
}
