/**
 * 核心域·项目元数据（P1 方案 §7 SPEC-01 的 project.yaml schema v1）。
 * 默认导出格式按 ADR-0001 §3.6 勘误为 markdown（v1 先行实现的格式）。
 * 顶层可选字段 expectedSceneCount 依 W2 GAP-03 裁决追加（schema 仍为 1，零迁移成本）。
 */

import type { WorkflowStep } from './workflow.js';

export const SCHEMA_VERSION = 1;

export const SCRIPT_FORMATS = ['screenplay', 'short-video', 'podcast'] as const;

export type ScriptFormat = (typeof SCRIPT_FORMATS)[number];

export function isScriptFormat(value: unknown): value is ScriptFormat {
  return typeof value === 'string' && (SCRIPT_FORMATS as readonly string[]).includes(value);
}

export interface AiSettings {
  enabled: boolean;
  provider: string | null;
}

export interface ExportSettings {
  default: string;
}

export interface ProjectSettings {
  ai: AiSettings;
  export: ExportSettings;
}

export interface ProjectProgress {
  step: WorkflowStep;
  scenesDone: string[];
}

export interface ProjectMeta {
  schema: number;
  title: string;
  format: ScriptFormat;
  /** ISO 日期（YYYY-MM-DD） */
  created: string;
  /**
   * 预计场数（正整数，向导第 ③ 问答案；GAP-03 裁决的顶层可选字段）。
   * 可选：字段缺失的旧式文件必须仍可读（消费方分母退化逻辑属 W1-P1-T05）。
   */
  expectedSceneCount?: number;
  settings: ProjectSettings;
  progress: ProjectProgress;
}

/** 向导第 ③ 问的默认值（SPEC-01：预计场数默认 5）。 */
export const DEFAULT_EXPECTED_SCENE_COUNT = 5;

export interface CreateProjectMetaInput {
  title: string;
  format?: ScriptFormat;
  /** 缺省取当天（UTC）；显式传入以获得确定性输出（测试/回放） */
  created?: string;
}

/**
 * 纯函数工厂：产出零配置可用的项目元数据默认值
 * （AI 关闭、导出 markdown、进度停在 init 之后的 outline 步）。
 */
export function createProjectMeta(input: CreateProjectMetaInput): ProjectMeta {
  return {
    schema: SCHEMA_VERSION,
    title: input.title,
    format: input.format ?? 'short-video',
    created: input.created ?? new Date().toISOString().slice(0, 10),
    settings: {
      ai: { enabled: false, provider: null },
      export: { default: 'markdown' },
    },
    progress: { step: 'outline', scenesDone: [] },
  };
}
