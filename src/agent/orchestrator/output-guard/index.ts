/**
 * Agent 层·受控输出层（TASK-P3-03，P3 方案 §2.4 F1 策略 + §2.8 技能消费）。
 *
 * 纪律：所有 `skill:*` 调用输出经 JSON Schema 校验——不受控输出**不得**进入业务逻辑。
 * F1 策略：校验失败 → 携带校验错误信息重试同一调用（≤2 次）；仍失败 → 降级为
 * 「纯文本草稿 + 需人工确认」标记（degraded），绝不静默吞错或返回空。
 * 每次 F1 处置落 `repair_event`（L2「失败有兜底」证据，E5 兜底触发率数据源）。
 *
 * 校验器为最小 JSON Schema 子集（type/required/properties/additionalProperties/
 * items/minItems/minLength/pattern/enum）——覆盖 prompts/schemas/ 现有口径；
 * 超子集的关键字在加载 schema 时抛错（不静默跳过），防「以为校验了实际没校验」。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSwError } from '../../../app/errors/registry.js';
import type { ModelGateway } from '../../gateway/types.js';
import type { Skill } from '../../prompts/types.js';
import type { Tracer } from '../../trace/tracer.js';
import { tracedLlmCall } from '../../trace/tracer.js';

// ---------------------------------------------------------------------------
// 最小 JSON Schema 校验器
// ---------------------------------------------------------------------------

/** 支持的 schema 关键字（超集出现即在 loadSchema 抛错）。 */
const SUPPORTED_KEYS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'minLength',
  'pattern',
  'enum',
]);

type Schema = Record<string, unknown>;

/** 加载并白名单校验 schema 文件；返回解析后的 schema 对象。 */
export async function loadSchema(rootDir: string, schemaPath: string): Promise<Schema> {
  const text = await readFile(join(rootDir, schemaPath), 'utf8');
  const schema = JSON.parse(text) as Schema;
  assertSupported(schema, schemaPath);
  return schema;
}

function assertSupported(schema: Schema, where: string): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYS.has(key)) {
      throw new Error(`${where}：schema 关键字 ${key} 超出受控输出层最小子集（请先扩充校验器再使用）`);
    }
  }
  if (typeof schema.properties === 'object' && schema.properties !== null) {
    for (const [prop, sub] of Object.entries(schema.properties as Record<string, unknown>)) {
      assertSupported(sub as Schema, `${where}.properties.${prop}`);
    }
  }
  if (typeof schema.items === 'object' && schema.items !== null && !Array.isArray(schema.items)) {
    assertSupported(schema.items as Schema, `${where}.items`);
  }
}

/** 校验错误（path 用 JSON 指针风：/scenes/0/scene_id）。 */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'integer') return typeOf(value) === 'integer';
  if (type === 'number') return typeof value === 'number';
  return typeOf(value) === type;
}

function validateValue(value: unknown, schema: Schema, path: string, issues: ValidationIssue[]): void {
  const type = schema.type;
  if (typeof type === 'string' && !matchesType(value, type)) {
    issues.push({ path, message: `类型应为 ${type}，实为 ${typeOf(value)}` });
    return; // 类型不符即停，后续约束无意义
  }

  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).some((v) => v === value)) {
    issues.push({ path, message: `取值须在枚举内：${(schema.enum as unknown[]).join('、')}` });
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      issues.push({ path, message: `长度 ${value.length} 小于 minLength ${schema.minLength}` });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      issues.push({ path, message: `不匹配 pattern ${schema.pattern}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push({ path, message: `数组长度 ${value.length} 小于 minItems ${schema.minItems}` });
    }
    if (typeof schema.items === 'object' && schema.items !== null) {
      value.forEach((item, i) => validateValue(item, schema.items as Schema, `${path}/${i}`, issues));
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in obj)) issues.push({ path, message: `缺必填字段 ${key}` });
    }
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [key, sub] of Object.entries(properties)) {
      if (key in obj) validateValue(obj[key], sub, `${path}/${key}`, issues);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) issues.push({ path, message: `未声明的字段 ${key}` });
      }
    }
  }
}

/** 校验入口：返回问题列表（空 = 通过）。 */
export function validateJson(value: unknown, schema: Schema): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateValue(value, schema, '', issues);
  return issues;
}

// ---------------------------------------------------------------------------
// 技能调用守卫（F1 策略）
// ---------------------------------------------------------------------------

/** 渲染技能模板：{{槽位}} ← inputs；{{rules}} ← 规则集拼接（保留槽，方案 §2.3 固定最前）。 */
export function renderSkillPrompt(
  skill: Skill,
  inputs: Readonly<Record<string, string>>,
  rulesText: readonly string[],
): string {
  let out = skill.body;
  out = out.split('{{rules}}').join(rulesText.join('\n\n'));
  for (const [slot, kind] of Object.entries(skill.meta.inputs)) {
    const value = inputs[slot];
    if (value === undefined) {
      if (kind === 'required') {
        throw new Error(`技能 ${skill.ref} 缺必填槽位：${slot}`);
      }
      out = out.split(`{{${slot}}}`).join('（未指定）');
    } else {
      out = out.split(`{{${slot}}}`).join(value);
    }
  }
  return out;
}

export interface GuardedCallResult {
  readonly status: 'validated' | 'degraded';
  /** validated：通过 schema 校验的结构化输出。 */
  readonly output?: unknown;
  /** degraded：纯文本草稿原文（需人工确认，F1 降级形态）。 */
  readonly draftText?: string;
  /** 实际尝试次数（1 = 一次通过；>1 = 发生了 F1 重试）。 */
  readonly attempts: number;
}

const F1_MAX_RETRIES = 2;

/**
 * 受控技能调用：渲染 → 网关（经 tracedLlmCall 落 llm_call）→ JSON 解析 + schema 校验；
 * 失败携带错误反馈重试 ≤2 次；仍失败 → degraded + repair_event(F1, degraded)。
 * 网关联络层失败（SW-E040）不属于 F1：tracedLlmCall 已落 F3 repair_event，本层原样上抛。
 */
export async function guardedSkillCall(options: {
  tracer: Tracer;
  gateway: ModelGateway;
  skill: Skill;
  schema: Schema;
  inputs: Readonly<Record<string, string>>;
  rulesText: readonly string[];
  contextSlots?: Readonly<Record<string, readonly string[]>>;
  now?: () => Date;
}): Promise<GuardedCallResult> {
  const { tracer, gateway, skill, schema, inputs, rulesText } = options;
  const basePrompt = renderSkillPrompt(skill, inputs, rulesText);
  let lastIssues: readonly ValidationIssue[] = [];
  let lastText = '';

  for (let attempt = 1; attempt <= 1 + F1_MAX_RETRIES; attempt += 1) {
    const feedback =
      attempt === 1
        ? ''
        : `\n\n上次输出未通过校验，问题如下：\n${lastIssues
            .map((i) => `- ${i.path || '/'}：${i.message}`)
            .join('\n')}\n请修正后只输出符合 schema 的 JSON。`;
    let result;
    try {
      result = await tracedLlmCall(
        tracer,
        gateway,
        { messages: [{ role: 'user', content: `${basePrompt}${feedback}` }] },
        { skill: skill.ref, contextSlots: options.contextSlots, now: options.now },
      );
    } catch (error) {
      if (isSwError(error)) throw error; // F3 已在 tracedLlmCall 落 repair_event
      throw error;
    }
    lastText = result.response.content;

    let parsed: unknown;
    let issues: readonly ValidationIssue[];
    try {
      parsed = JSON.parse(lastText);
      issues = validateJson(parsed, schema);
    } catch {
      issues = [{ path: '', message: '输出不是合法 JSON' }];
    }
    if (issues.length === 0) {
      if (attempt > 1) {
        await tracer.emit({
          run_id: tracer.runId,
          ts: (options.now ?? (() => new Date()))().toISOString(),
          kind: 'repair_event',
          failure_code: 'F1',
          strategy: `携带校验错误重试（第 ${attempt - 1} 次重试后通过）`,
          result: 'recovered',
        });
      }
      return { status: 'validated', output: parsed, attempts: attempt };
    }
    lastIssues = issues;
  }

  // F1 降级：纯文本草稿 + 需人工确认（方案 §2.4：兜底形态 = 可用部分交用户 + 明确原因）
  await tracer.emit({
    run_id: tracer.runId,
    ts: (options.now ?? (() => new Date()))().toISOString(),
    kind: 'repair_event',
    failure_code: 'F1',
    strategy: `重试 ${F1_MAX_RETRIES} 次仍未通过校验，降级为纯文本草稿 + 需人工确认`,
    result: 'degraded',
  });
  return { status: 'degraded', draftText: lastText, attempts: 1 + F1_MAX_RETRIES };
}
