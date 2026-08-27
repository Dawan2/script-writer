/**
 * 应用层·状态报告渲染（SPEC-02：sw status 输出项目标题、当前步骤、场景完成度，
 * 且**末行是可直接复制执行的下一步命令**——不含 <占位符>）。
 * 失败消息按 SPEC-03 三段式（发生了什么/为什么/怎么办）书写；
 * TODO(W1-P1-T06)：错误框架合入后迁移到 fail(code, ctx)/hint(slot, ctx) 统一渲染。
 */

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
 * 步骤未到 draft 时先补大纲；draft/revise 阶段依磁盘现状给出具体场编号。
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
    return `sw draft ${suggestNextSceneId(disk.sceneIds)}`;
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

/** 失败态渲染：三段式（发生了什么/为什么/怎么办），错误码沿用 SPEC-03 注册表既定编号。 */
export function renderProjectFailure(failure: ProjectFailure): string[] {
  switch (failure.reason) {
    case 'not-a-project':
      return [
        '✖ SW-E011 当前目录不是 script-writer 项目',
        '  原因：未找到 project.yaml。',
        '  怎么办：cd 到既有项目目录；或运行 `sw init` 新建项目（init 向导由 W1-P1-T04 交付）。',
      ];
    case 'invalid-yaml':
      return [
        '✖ project.yaml 无法解析',
        `  原因：不是合法 YAML——${failure.detail}`,
        '  怎么办：用编辑器检查最近改动，或从 git 历史恢复该文件。',
      ];
    case 'schema-incompatible':
      return [
        '✖ SW-E020 project.yaml 的 schema 版本不兼容',
        `  原因：文件声明 schema: ${String(failure.found)}，当前程序支持 schema: ${failure.expected}。`,
        '  怎么办：升级 script-writer 到匹配版本；迁移工具随后续 schema 版本一起提供。',
      ];
    case 'malformed':
      return [
        '✖ project.yaml 字段不完整或类型错误',
        ...failure.issues.map((issue) => `  原因：${issue}`),
        '  怎么办：按上述提示修正字段，或从 git 历史恢复该文件。',
      ];
  }
}
