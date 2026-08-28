/**
 * 接口层·命令注册表（SPEC-07 §4.1，W4-HELP-T01）：全库命令信息的单一数据源。
 *
 * 默认 help、help --all、路线图行与挂载循环全部自本表生成（GAP-02：禁止手工清单）。
 * 短别名在本表 alias 字段集中声明，由 mountCommands 在挂载循环内统一注入——
 * 这是全库唯一的 .alias() 调用点（ESLint no-restricted-syntax 拦截表外调用，SPEC-07 §4.2-4）。
 *
 * 纪律：
 * - planned 条目零注册（禁填 register，不产生可执行命令，虚假可用性禁令）；
 *   命令落地时由使能槽在同一提交内把 planned → available 并补 register。
 * - main 组按五步工作流序（init → outline → draft → revise → export → status），
 *   aux 组按数组序；渲染层不做二次排序（输出确定性）。
 * - 别名仅小写、长度 1–2、全表唯一且不与主命令词冲突；不预占未裁决别名（§4.2-3）。
 */

import type { Command } from 'commander';
import type { CliIo } from './io.js';
import { registerInitCommand } from './commands/init.js';
import { registerStatusCommand } from './commands/status.js';
import { registerHelpCommand } from './commands/help.js';

export interface CommandSpec {
  /** 主命令词（与文档/目录同词汇，P1 §6.1 词汇一致性）。 */
  name: string;
  /** 短别名（SPEC-07 §4.2 全集六只 i/o/d/r/x/s）；无别名则省略。 */
  alias?: string;
  /** 一句话（默认 help / --all / 路线图共用）。 */
  summary: string;
  /** main = 五步主命令 + status（默认 help 展示）；aux = 其余。 */
  group: 'main' | 'aux';
  /** planned 不注册命令，仅入路线图与 --all「规划中」段。 */
  status: 'available' | 'planned';
  /** 责任任务 ID（诚实进度标注来源）。 */
  taskId: string;
  /** available 必填；planned 禁填。 */
  register?: (program: Command, io: CliIo) => void;
}

/**
 * 命令注册表（数组序即渲染序，见模块头注释）。
 * 内容以落地时点实现现状为准（集成分支头 b99cb92：available = init/status/help）。
 */
export const COMMAND_REGISTRY: readonly CommandSpec[] = [
  {
    name: 'init',
    alias: 'i',
    summary: '初始化项目向导（≤ 4 问；--yes 非交互全默认）',
    group: 'main',
    status: 'available',
    taskId: 'W1-P1-T04',
    register: registerInitCommand,
  },
  {
    name: 'outline',
    alias: 'o',
    summary: '编辑大纲',
    group: 'main',
    status: 'planned',
    taskId: 'W1-P1-T07',
  },
  {
    name: 'draft',
    alias: 'd',
    summary: '起草/续写场景',
    group: 'main',
    status: 'planned',
    taskId: 'W3-DRAFT-T01',
  },
  {
    name: 'revise',
    alias: 'r',
    summary: '改写场景',
    group: 'main',
    status: 'planned',
    taskId: 'W2-GAP-T01',
  },
  {
    name: 'export',
    alias: 'x',
    summary: '导出脚本',
    group: 'main',
    status: 'planned',
    taskId: 'W3-DRAFT-T02',
  },
  {
    name: 'status',
    alias: 's',
    summary: '显示项目进度与下一步命令（在项目目录内运行）',
    group: 'main',
    status: 'available',
    taskId: 'W1-P1-T05 最小版',
    register: registerStatusCommand,
  },
  {
    name: 'doctor',
    summary: '诊断配置与项目文件健康',
    group: 'aux',
    status: 'planned',
    taskId: 'W1-P1-T08',
  },
  {
    name: 'help',
    summary: '显示帮助（--all 查看全部命令与别名）',
    group: 'aux',
    status: 'available',
    taskId: 'W2-GAP-T02',
    // 自举：help 渲染需要注册表本身，闭包传入（同模块引用，无跨模块循环）。
    register: (program, io) => {
      registerHelpCommand(program, io, COMMAND_REGISTRY);
    },
  },
];

/**
 * 唯一挂载循环（SPEC-07 §4.1-1）：遍历注册表注册 available 条目，
 * 并在循环内统一注入 .alias() 与别名可见性尾注（§4.5）。
 * 各命令模块的 registerXCommand 内部零改动。
 */
export function mountCommands(program: Command, io: CliIo): void {
  for (const spec of COMMAND_REGISTRY) {
    if (spec.status !== 'available' || spec.register === undefined) {
      continue;
    }
    spec.register(program, io);
    if (spec.alias !== undefined) {
      const command = program.commands.find((c) => c.name() === spec.name);
      if (command !== undefined) {
        command.alias(spec.alias);
        command.addHelpText('after', `\n短别名：sw ${spec.alias} ≡ sw ${spec.name}\n`);
      }
    }
  }
}
