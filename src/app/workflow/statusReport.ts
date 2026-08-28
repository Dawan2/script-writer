/**
 * 应用层·状态报告渲染（SPEC-02：sw status 输出项目标题、当前步骤、场景完成度，
 * 且**末行是可直接复制执行的下一步命令**——不含 <占位符>）。
 * 失败路径已迁移到 SPEC-03 错误框架（W3 集成，语义冲突 ② 核销）：
 * 引擎的 ProjectFailure 判别联合经 failProject() 统一转为 fail(code, ctx)，
 * 三段式渲染与退出码 1 由 CLI 顶层 catch（src/cli/run.ts）负责。
 */

import { fail } from '../errors/registry.js';
import { WORKFLOW_STEPS } from '../../core/model/workflow.js';
import { isStepBefore } from '../../core/model/progress.js';
import { padSceneId } from '../../infra/store/layout.js';
import type { ProjectFailure, ProjectStatus } from './engine.js';

const STEP_PATH = WORKFLOW_STEPS.join(' → ');

/** 空态建议命令（P1 §6.3 空态三要素的"下一步敲什么"，与规范示例一致）。 */
export const FIRST_SCENE_COMMAND = 'sw draft 010 --title "开场"';

/** 依据磁盘已有场编号推算下一个可复制的场编号（步长 10，沿用 010/020 惯例）。 */
export function suggestNextSceneId(sceneIds: readonly string[]): string {
  const max = sceneIds.reduce((acc, id) => {
    const n = Number.parseInt(id, 10);
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  return padSceneId(max + 10);
}

/**
 * 计算下一步建议命令：整条命令可直接粘贴执行。
 * 步骤未到 draft 时先补大纲；draft 期细化（SPEC-05 §4.4-4）：
 * ① 磁盘无场 → 第一场完整示例；② 有场未标完成 → 首个未完成场的 --done 命令；
 * ③ 全部已完成且未达预计场数（expectedSceneCount，GAP-03 消费侧；字段缺省视为已达）→ 下一场；
 * ④ 全部已完成且已达预计场数 → sw export（revise 未注册前不落 sw revise——虚假可用性禁令 §3-6，
 * 切换到 sw revise 与 W2-GAP-T01 命令注册同提交，SPEC-04 §6.3）。
 */
export function nextActionCommand(status: ProjectStatus): string {
  const { meta, disk } = status;
  const step = meta.progress.step;

  if (isStepBefore(step, 'draft')) {
    return 'sw outline';
  }
  if (step === 'draft') {
    if (disk.sceneIds.length === 0) {
      return FIRST_SCENE_COMMAND; // 空态：给出第一场的完整示例命令
    }
    const done = new Set(meta.progress.scenesDone);
    const firstUndone = disk.sceneIds.find((id) => !done.has(id));
    if (firstUndone !== undefined) {
      return `sw draft ${firstUndone} --done`;
    }
    if (
      meta.expectedSceneCount !== undefined &&
      disk.sceneIds.length < meta.expectedSceneCount
    ) {
      return `sw draft ${suggestNextSceneId(disk.sceneIds)}`;
    }
    return 'sw export';
  }
  if (step === 'revise') {
    const first = disk.sceneIds[0];
    return first === undefined ? FIRST_SCENE_COMMAND : `sw draft ${first} --force`;
  }
  return 'sw export';
}

/** 成功态渲染：SPEC-02 约定末行为可复制的下一步命令。 */
export function renderStatusReport(status: ProjectStatus): string[] {
  const { meta, scenes } = status;
  const stepNumber = WORKFLOW_STEPS.indexOf(meta.progress.step) + 1;
  return [
    `项目：${meta.title}（${meta.format}）`,
    `当前步骤：${meta.progress.step}（第 ${stepNumber}/${WORKFLOW_STEPS.length} 步：${STEP_PATH}）`,
    `场景完成度：${scenes.done}/${scenes.total} 场已完成`,
    '下一步（可直接复制执行）：',
    nextActionCommand(status),
  ];
}

/**
 * 失败态出口（语义冲突 ② 核销）：引擎判别联合 → 注册表错误码，经 fail() 唯一入口抛出。
 * 映射表：not-a-project → SW-E011；invalid-yaml → SW-E021；
 * schema-incompatible → SW-E020；malformed → SW-E022。
 * 渲染（三段式 + 文档锚点）与退出码 1 由 CLI 顶层 catch 统一负责，本层不再手写文案。
 */
export function failProject(failure: ProjectFailure, projectDir: string): never {
  switch (failure.reason) {
    case 'not-a-project':
      return fail('SW-E011', { cwd: projectDir });
    case 'invalid-yaml':
      return fail('SW-E021', { detail: failure.detail });
    case 'schema-incompatible':
      return fail('SW-E020', {
        found: typeof failure.found === 'number' ? failure.found : String(failure.found),
        supported: failure.expected,
      });
    case 'malformed':
      return fail('SW-E022', { issues: failure.issues });
  }
}
