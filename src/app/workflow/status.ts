/**
 * 应用层·状态提示（SPEC-02 的"输出末行为可复制的下一步命令"约定的最小载体）。
 * 完整工作流引擎属 W1-P1-T05；本模块先固化"步骤 → 建议命令"映射，供 CLI 与后续引擎共用。
 */

import type { WorkflowStep } from '../../core/model/workflow.js';

const STEP_COMMANDS: Record<WorkflowStep, string> = {
  init: 'sw init',
  outline: 'sw outline',
  draft: 'sw draft <scene-id>',
  revise: 'sw draft <scene-id> --force',
  export: 'sw export',
};

/** 给定当前步骤，返回可直接复制执行的建议命令。 */
export function nextCommandHint(step: WorkflowStep): string {
  return STEP_COMMANDS[step];
}
