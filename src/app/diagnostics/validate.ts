/**
 * 应用层·project.yaml 字段级校验（W1-P1-T08 doctor 的 schema 检查内核，纯函数零 IO）。
 *
 * 移植适配（源分支 `cursor/w3-doctor-3e3d` 的 validateRawProjectMeta 整体替换，
 * 其 work-doctor.md §4-2/§5 交接注记明文允许）：底层校验不再用手写子集解析器，
 * 直接消费引擎的 parseProjectMeta（yaml 严格解析 + 逐条 issues），
 * 诊断层只把引擎的判别联合映射为「逐条问题清单 + 下游视图」。
 */

import { SCHEMA_VERSION } from '../../core/model/project.js';
import { parseProjectMeta } from '../../core/model/parseProject.js';

export interface ProjectMetaFindings {
  /** 逐条校验问题（空数组 = 全部通过） */
  issues: string[];
  /** progress.scenes_done（字段合法时给出，供场景一致性检查；否则 null） */
  scenesDone: string[] | null;
  /** settings.ai.enabled（字段合法时给出，供 AI key 检查；否则 null） */
  aiEnabled: boolean | null;
}

/** 字段级校验：schema 版本不符单条指明期望/实际；其余畸形逐条列全（不首错即停）。 */
export function validateProjectMeta(data: unknown): ProjectMetaFindings {
  const parsed = parseProjectMeta(data);
  if (parsed.ok) {
    return {
      issues: [],
      scenesDone: parsed.meta.progress.scenesDone,
      aiEnabled: parsed.meta.settings.ai.enabled,
    };
  }
  if (parsed.reason === 'schema-incompatible') {
    return {
      issues: [`schema 版本不符（期望 ${SCHEMA_VERSION}，实际 ${String(parsed.found)}）`],
      scenesDone: null,
      aiEnabled: null,
    };
  }
  return { issues: parsed.issues, scenesDone: null, aiEnabled: null };
}
