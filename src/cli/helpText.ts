/**
 * 接口层·help 渲染模块（SPEC-07 §4.3/§4.4）：默认 help 尾注、路线图、--all 全集
 * 三视图同源——全部自命令注册表生成，禁止任何手工清单（GAP-02）。
 *
 * 输出纪律（§4.2-5）：一切报告与建议输出一律印主命令全词，不回显别名。
 */

import { existsSync } from 'node:fs';
import type { CommandSpec } from './registry.js';

/** 五步工作流主命令序（init → outline → draft → revise → export），路线图首行用。 */
const FIVE_STEP_NAMES = ['init', 'outline', 'draft', 'revise', 'export'];

function pad(text: string, width: number): string {
  return text.padEnd(width, ' ');
}

function availabilityMark(spec: CommandSpec): string {
  return spec.status === 'available' ? `[可用 · ${spec.taskId}]` : `[规划中 · ${spec.taskId}]`;
}

/** 命令行词条：`draft|d` 形态（有别名时），供 --all 与路线图清单共用。 */
export function commandLabel(spec: CommandSpec): string {
  return spec.alias === undefined ? spec.name : `${spec.name}|${spec.alias}`;
}

/**
 * 默认 help 的 after 尾注（SPEC-07 §4.3）：五步路线图首行 + main 组逐行进度 +
 * help --all 提示行 + 尾部文档 URL。首行与逐行清单由同一数据生成，漏行不可能复现。
 */
export function renderDefaultHelpTail(registry: readonly CommandSpec[]): string {
  const main = registry.filter((s) => s.group === 'main');
  const fiveStep = FIVE_STEP_NAMES.map((name) => {
    const spec = main.find((s) => s.name === name);
    return spec === undefined ? name : spec.name;
  }).join(' → ');
  const lines = [
    '',
    `主工作流（五步，P1 方案 §6.2）：${fiveStep}`,
    '',
    '子命令实现进度：',
    ...main.map(
      (s) => `  ${pad(`sw ${s.name}`, 14)}${pad(s.summary, 22)}${availabilityMark(s)}`,
    ),
    '',
    '运行 sw help --all 查看全部命令与别名',
    '',
    '文档：https://github.com/Dawan2/script-writer/blob/main/docs/quickstart.md',
    '',
  ];
  return lines.join('\n');
}

/**
 * help --all 尾部 URL 的出现条件（SPEC-07 §6.3 渐进增强）：
 * docs/user/commands.md 已并入实现所基于的分支才印；未并入前该行不印（虚假 URL 禁令）。
 * 相对本模块两级向上即仓库根（src/cli/ 与 dist/cli/ 深度一致）。
 */
export function userCommandsDocAvailable(): boolean {
  return existsSync(new URL('../../docs/user/commands.md', import.meta.url));
}

/**
 * `sw help --all` 全集视图（SPEC-07 §4.4）：三段分组——主工作流（main available）、
 * 辅助命令（aux available）、规划中（planned + 责任任务标注）；全部生成自注册表。
 */
export function renderAllHelp(registry: readonly CommandSpec[]): string {
  const mainAvailable = registry.filter((s) => s.group === 'main' && s.status === 'available');
  const auxAvailable = registry.filter((s) => s.group === 'aux' && s.status === 'available');
  const planned = registry.filter((s) => s.status === 'planned');
  const row = (s: CommandSpec): string =>
    `  ${pad(`sw ${commandLabel(s)}`, 14)}${s.summary}`;
  const lines = [
    '全部命令与别名：',
    '',
    '主工作流：',
    ...mainAvailable.map(row),
    '',
    '辅助命令：',
    ...auxAvailable.map(row),
    '',
    '规划中：',
    ...planned.map((s) => `${row(s)}  ${availabilityMark(s)}`),
    '',
  ];
  if (userCommandsDocAvailable()) {
    lines.push(
      '命令详情：https://github.com/Dawan2/script-writer/blob/main/docs/user/commands.md',
      '',
    );
  }
  return lines.join('\n');
}
