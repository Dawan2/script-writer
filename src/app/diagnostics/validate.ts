/**
 * 应用层·project.yaml 字段级校验（W1-P1-T08 doctor 的 schema 检查内核，纯函数零 IO）。
 *
 * 输入为 infra 子集解析出的原始结构，输出逐条问题清单（供红项一次性列全，
 * 而非首错即停），并在对应字段自身合法时输出下游检查所需的类型化视图
 * （scenes_done → 场景一致性检查；ai.enabled → AI key 检查）。
 */

import {
  SCHEMA_VERSION,
  SCRIPT_FORMATS,
  isScriptFormat,
} from '../../core/model/project.js';
import { WORKFLOW_STEPS, isWorkflowStep } from '../../core/model/workflow.js';
import type { RawMap, RawValue } from '../../infra/store/projectMetaRead.js';

export interface ProjectMetaFindings {
  /** 逐条校验问题（空数组 = 全部通过） */
  issues: string[];
  /** progress.scenes_done（字段自身合法时给出，供场景一致性检查；否则 null） */
  scenesDone: string[] | null;
  /** settings.ai.enabled（字段自身合法时给出，供 AI key 检查；否则 null） */
  aiEnabled: boolean | null;
}

function isRawMap(value: RawValue | undefined): value is RawMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: RawValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function validateRawProjectMeta(raw: RawMap): ProjectMetaFindings {
  const issues: string[] = [];

  if (typeof raw.schema !== 'number') {
    issues.push('缺少 schema 字段或其值不是数字');
  } else if (raw.schema !== SCHEMA_VERSION) {
    issues.push(`schema 版本不符（期望 ${SCHEMA_VERSION}，实际 ${raw.schema}）`);
  }

  if (typeof raw.title !== 'string' || raw.title.trim() === '') {
    issues.push('缺少 title 或其值不是非空字符串');
  }

  if (!isScriptFormat(raw.format)) {
    issues.push(`format 非法（合法值：${SCRIPT_FORMATS.join(' / ')}）`);
  }

  if (typeof raw.created !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.created)) {
    issues.push('created 不是 YYYY-MM-DD 日期');
  }

  if ('expectedSceneCount' in raw) {
    const count = raw.expectedSceneCount;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
      issues.push('expectedSceneCount 必须是正整数（GAP-03）');
    }
  }

  let aiEnabled: boolean | null = null;
  if (!isRawMap(raw.settings)) {
    issues.push('缺少 settings 小节');
  } else {
    const ai = raw.settings.ai;
    if (!isRawMap(ai) || typeof ai.enabled !== 'boolean' || (ai.provider !== null && typeof ai.provider !== 'string')) {
      issues.push('settings.ai 结构非法（需 enabled 布尔与 provider 字符串或 null）');
    } else {
      aiEnabled = ai.enabled;
    }
    const exportSettings = raw.settings.export;
    if (!isRawMap(exportSettings) || typeof exportSettings.default !== 'string' || exportSettings.default.trim() === '') {
      issues.push('settings.export 结构非法（需 default 非空字符串）');
    }
  }

  let scenesDone: string[] | null = null;
  if (!isRawMap(raw.progress)) {
    issues.push('缺少 progress 小节');
  } else {
    if (!isWorkflowStep(raw.progress.step)) {
      issues.push(`progress.step 非法（合法值：${WORKFLOW_STEPS.join(' / ')}）`);
    }
    if (!isStringArray(raw.progress.scenes_done)) {
      issues.push('progress.scenes_done 必须是字符串数组');
    } else {
      scenesDone = raw.progress.scenes_done;
    }
  }

  return { issues, scenesDone, aiEnabled };
}
