/**
 * 核心域·project.yaml schema v1 的解析与序列化纯函数（SPEC-02 引擎数据流 ①"读取并校验"）。
 * 本层零 IO：输入是已由基础设施层解析好的普通对象（unknown），输出是领域模型或结构化失败原因；
 * YAML 文本的读写属 src/infra/store/projectFile.ts。
 *
 * 文件形态（snake_case，如 scenes_done）与领域模型（camelCase，如 scenesDone）在此互转，
 * 保证磁盘契约与 SPEC-01 示例逐字段一致、代码侧命名符合 TS 惯例。
 */

import {
  SCHEMA_VERSION,
  isScriptFormat,
  type ProjectMeta,
} from './project.js';
import { isWorkflowStep } from './workflow.js';

/** project.yaml v1 的磁盘形态（键名与 SPEC-01 示例一致；expectedSceneCount 为 GAP-03 顶层可选字段）。 */
export interface ProjectFileShape {
  schema: number;
  title: string;
  format: string;
  created: string;
  /** 预计场数（正整数，向导第 ③ 问答案；可选，旧式文件缺省仍可读——GAP-03/W2-GAP-T03）。 */
  expectedSceneCount?: number;
  settings: {
    ai: { enabled: boolean; provider: string | null };
    export: { default: string };
  };
  progress: {
    step: string;
    scenes_done: string[];
  };
}

export type ParseProjectResult =
  | { ok: true; meta: ProjectMeta }
  /** schema 版本不兼容（SW-E020 语义；错误渲染待 SPEC-03/T06 框架接管）。 */
  | { ok: false; reason: 'schema-incompatible'; found: unknown; expected: number }
  /** 字段缺失或类型错误；issues 逐条描述（供三段式错误消息的"为什么"段）。 */
  | { ok: false; reason: 'malformed'; issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验并解析 project.yaml 的数据体为领域模型（引擎每条命令启动时的第一步）。 */
export function parseProjectMeta(data: unknown): ParseProjectResult {
  if (!isRecord(data)) {
    return { ok: false, reason: 'malformed', issues: ['project.yaml 顶层必须是映射（key: value）'] };
  }

  // schema 版本先行判定：数字但不等于当前版本 → 版本不兼容（有迁移指引）；
  // 缺失或非数字 → 字段级畸形（无从判断版本，归入 malformed）。
  const schema = data['schema'];
  if (typeof schema !== 'number') {
    return { ok: false, reason: 'malformed', issues: ['缺少数字字段 schema（当前版本应为 1）'] };
  }
  if (schema !== SCHEMA_VERSION) {
    return { ok: false, reason: 'schema-incompatible', found: schema, expected: SCHEMA_VERSION };
  }

  const issues: string[] = [];

  const title = data['title'];
  if (typeof title !== 'string' || title.trim().length === 0) {
    issues.push('title 必须是非空字符串');
  }

  const format = data['format'];
  if (!isScriptFormat(format)) {
    issues.push('format 必须是 screenplay | short-video | podcast 之一');
  }

  const created = data['created'];
  const createdText =
    created instanceof Date ? created.toISOString().slice(0, 10) : created;
  if (typeof createdText !== 'string' || !ISO_DATE.test(createdText)) {
    issues.push('created 必须是 ISO 日期（YYYY-MM-DD）');
  }

  // GAP-03 可选字段：缺省合法（旧式文件兼容）；出现则必须是正整数。
  const expectedSceneCountRaw = data['expectedSceneCount'];
  let expectedSceneCount: number | undefined;
  if (expectedSceneCountRaw !== undefined && expectedSceneCountRaw !== null) {
    if (
      typeof expectedSceneCountRaw !== 'number' ||
      !Number.isInteger(expectedSceneCountRaw) ||
      expectedSceneCountRaw < 1
    ) {
      issues.push('expectedSceneCount 必须是正整数（或省略该字段）');
    } else {
      expectedSceneCount = expectedSceneCountRaw;
    }
  }

  const settings = data['settings'];
  let ai: { enabled: boolean; provider: string | null } | null = null;
  let exportDefault: string | null = null;
  if (!isRecord(settings)) {
    issues.push('settings 必须是映射（含 ai 与 export 两段）');
  } else {
    const aiRaw = settings['ai'];
    if (
      !isRecord(aiRaw) ||
      typeof aiRaw['enabled'] !== 'boolean' ||
      (aiRaw['provider'] !== null && typeof aiRaw['provider'] !== 'string')
    ) {
      issues.push('settings.ai 必须形如 { enabled: 布尔, provider: 字符串或 null }');
    } else {
      ai = { enabled: aiRaw['enabled'], provider: aiRaw['provider'] ?? null };
    }
    const exportRaw = settings['export'];
    if (!isRecord(exportRaw) || typeof exportRaw['default'] !== 'string' || exportRaw['default'].length === 0) {
      issues.push('settings.export.default 必须是非空字符串');
    } else {
      exportDefault = exportRaw['default'];
    }
  }

  const progress = data['progress'];
  let step: ProjectMeta['progress']['step'] | null = null;
  let scenesDone: string[] | null = null;
  if (!isRecord(progress)) {
    issues.push('progress 必须是映射（含 step 与 scenes_done）');
  } else {
    const stepRaw = progress['step'];
    if (!isWorkflowStep(stepRaw)) {
      issues.push('progress.step 必须是 init|outline|draft|revise|export 之一');
    } else {
      step = stepRaw;
    }
    const scenesRaw = progress['scenes_done'];
    if (!Array.isArray(scenesRaw) || scenesRaw.some((item) => typeof item !== 'string')) {
      issues.push('progress.scenes_done 必须是字符串数组');
    } else {
      scenesDone = scenesRaw as string[];
    }
  }

  if (issues.length > 0 || ai === null || exportDefault === null || step === null || scenesDone === null) {
    return { ok: false, reason: 'malformed', issues };
  }

  return {
    ok: true,
    meta: {
      schema: SCHEMA_VERSION,
      title: (title as string).trim(),
      format: format as ProjectMeta['format'],
      created: createdText as string,
      ...(expectedSceneCount !== undefined ? { expectedSceneCount } : {}),
      settings: { ai, export: { default: exportDefault } },
      progress: { step, scenesDone },
    },
  };
}

/** 领域模型 → 磁盘形态（供基础设施层 stringify 为 YAML；与 parseProjectMeta 互逆）。 */
export function toProjectFileShape(meta: ProjectMeta): ProjectFileShape {
  return {
    schema: meta.schema,
    title: meta.title,
    format: meta.format,
    created: meta.created,
    // 可选字段仅在存在时写入（往返不丢、缺省不冒出 null——GAP-03 数据丢失级风险的存储侧堵点）
    ...(meta.expectedSceneCount !== undefined
      ? { expectedSceneCount: meta.expectedSceneCount }
      : {}),
    settings: {
      ai: { enabled: meta.settings.ai.enabled, provider: meta.settings.ai.provider },
      export: { default: meta.settings.export.default },
    },
    progress: {
      step: meta.progress.step,
      scenes_done: [...meta.progress.scenesDone],
    },
  };
}
