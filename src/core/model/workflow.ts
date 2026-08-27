/**
 * 核心域·工作流步骤词汇表（P1 方案 §6.2 五步主工作流）。
 * 本层零 IO（P1 §5.1 硬约束）：只定义领域词汇与纯函数，不感知文件系统/网络/CLI。
 */

export const WORKFLOW_STEPS = ['init', 'outline', 'draft', 'revise', 'export'] as const;

export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export function isWorkflowStep(value: unknown): value is WorkflowStep {
  return typeof value === 'string' && (WORKFLOW_STEPS as readonly string[]).includes(value);
}

/** 返回主工作流中的下一步；最后一步（export）返回 null。 */
export function nextStep(step: WorkflowStep): WorkflowStep | null {
  const index = WORKFLOW_STEPS.indexOf(step);
  return WORKFLOW_STEPS[index + 1] ?? null;
}
