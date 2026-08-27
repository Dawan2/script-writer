/**
 * 核心域·工作流进度状态机纯函数（SPEC-02"恢复式工作流引擎"的领域内核）。
 * 零 IO：磁盘现状由基础设施层扫描后以 ProjectDiskSnapshot 注入，本层只做计算，
 * 保证 CLI 与未来 Web 形态共享同一套进度语义（P1 §5.1）。
 */

import { WORKFLOW_STEPS, type WorkflowStep } from './workflow.js';
import type { ProjectProgress } from './project.js';

/** 项目目录的只读快照（由 src/infra/store 扫描产出）。 */
export interface ProjectDiskSnapshot {
  outlineExists: boolean;
  /** scenes/ 目录中实际存在的场编号（如 ["010", "020"]），按文件名升序。 */
  sceneIds: readonly string[];
}

function stepIndex(step: WorkflowStep): number {
  return WORKFLOW_STEPS.indexOf(step);
}

/**
 * 幂等记录场景完成（SPEC-02：draft 完成后把 id 记入 progress.scenes_done）。
 * 同一 id 重复记录不产生变化（§6.2 幂等约束）；返回新对象，不改入参。
 */
export function recordSceneDone(progress: ProjectProgress, sceneId: string): ProjectProgress {
  const id = sceneId.trim();
  if (id.length === 0) {
    throw new RangeError('场编号不能为空');
  }
  if (progress.scenesDone.includes(id)) {
    return progress;
  }
  return { ...progress, scenesDone: [...progress.scenesDone, id].sort() };
}

/**
 * 把步骤至少推进到 floor（§6.2 可跳过：直接 sw draft 时引擎自动把 outline 步补齐到 draft）。
 * 已在 floor 或之后时原样返回（幂等，不回退）。
 */
export function ensureStepAtLeast(progress: ProjectProgress, floor: WorkflowStep): ProjectProgress {
  if (stepIndex(progress.step) >= stepIndex(floor)) {
    return progress;
  }
  return { ...progress, step: floor };
}

/** a 是否严格早于 b（五步顺序）。 */
export function isStepBefore(a: WorkflowStep, b: WorkflowStep): boolean {
  return stepIndex(a) < stepIndex(b);
}

/**
 * 场景完成度（sw status 的 "3/5 场已完成"）：
 * 分母优先取 GAP-03 的 expectedSceneCount（init 向导第 ③ 问答案）；
 * 字段缺省时退化为磁盘实际场文件数（engine 既定行为，比裁决文本的
 * scenes_done 长度信息量更足，作为集成决策登记于 wave-03 落地说明）。
 */
export interface SceneCompletion {
  done: number;
  total: number;
}

export function sceneCompletion(
  progress: ProjectProgress,
  disk: ProjectDiskSnapshot,
  expectedSceneCount?: number,
): SceneCompletion {
  return {
    done: progress.scenesDone.length,
    total: expectedSceneCount ?? disk.sceneIds.length,
  };
}
