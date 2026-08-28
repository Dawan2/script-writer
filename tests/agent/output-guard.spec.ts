/**
 * 受控输出层测试（TASK-P3-03）。
 * 三路径验收：一次通过 / 重试后通过（F1 recovered）/ 降级（F1 degraded）；
 * 另有校验器子集、模板渲染、F3 上抛不混 F1 的边界断言。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGateway } from '../../src/agent/gateway/gateway.js';
import {
  guardedSkillCall,
  loadSchema,
  renderSkillPrompt,
  validateJson,
} from '../../src/agent/orchestrator/output-guard/index.js';
import { loadPromptStore } from '../../src/agent/prompts/loader.js';
import { parseTraceJsonl } from '../../src/agent/trace/summary.js';
import { createTracer } from '../../src/agent/trace/tracer.js';

const REPO_ROOT = process.cwd();
const FIXED_NOW = new Date('2026-08-28T08:00:00.000Z');

let dir: string;
let runFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-guard-'));
  runFile = join(dir, 'runs', 'run-g.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 依次返回 canned 内容的假 fetch（OpenAI 兼容回包形态）。 */
function cannedFetch(contents: readonly string[]) {
  let i = 0;
  const bodies: string[] = [];
  const fetchFn = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body));
    const content = contents[Math.min(i, contents.length - 1)] ?? '';
    i += 1;
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200 },
    );
  };
  return { fetchFn: fetchFn as unknown as typeof fetch, bodies };
}

function gatewayWith(fetchFn: typeof fetch) {
  return createGateway(
    {
      provider: 'openai-compatible',
      apiKey: 'sk-guard-test',
      baseUrl: 'https://example.invalid/v1',
      model: 'm1',
      timeoutMs: 1_000,
      maxRetries: 0,
      backoffBaseMs: 1,
    },
    { fetchFn },
  );
}

const GOOD_JSON = JSON.stringify({ scenes: [{ scene_id: '010', summary: '雨夜来电' }] });
const BAD_JSON = '{不是json';
const SCHEMA_BAD_JSON = JSON.stringify({ scenes: [{ scene_id: 'x', summary: '' }] });

describe('agent/output-guard：最小 JSON Schema 校验器', () => {
  const schema = {
    type: 'object',
    required: ['scenes'],
    additionalProperties: false,
    properties: {
      scenes: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['scene_id', 'summary'],
          properties: {
            scene_id: { type: 'string', pattern: '^[0-9]{3,}$' },
            summary: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  };

  it('合法值零问题', () => {
    expect(validateJson(JSON.parse(GOOD_JSON), schema)).toEqual([]);
  });

  it('类型/required/pattern/minLength/additionalProperties/minItems 逐类检出且带路径', () => {
    const issues = (v: unknown) => validateJson(v, schema);
    expect(issues({})).toEqual([{ path: '', message: '缺必填字段 scenes' }]);
    expect(issues({ scenes: [], extra: 1 }).map((i) => i.message)).toEqual([
      '数组长度 0 小于 minItems 1',
      '未声明的字段 extra',
    ]);
    expect(issues({ scenes: [{ scene_id: 'x', summary: 'a' }] })[0]).toMatchObject({
      path: '/scenes/0/scene_id',
    });
    expect(issues({ scenes: [{ scene_id: '010', summary: '' }] })[0]?.message).toContain('minLength');
    expect(issues({ scenes: 'no' })[0]?.message).toContain('类型应为 array');
  });

  it('真实仓库 schema 可加载；超出最小子集的关键字抛错（不静默跳过）', async () => {
    const schema = await loadSchema(REPO_ROOT, 'prompts/schemas/outline-draft.json');
    expect(schema.type).toBe('object');
    const bad = join(dir, 'bad.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(bad, JSON.stringify({ type: 'object', not: {} }));
    await expect(loadSchema(dir, 'bad.json')).rejects.toThrowError(/超出受控输出层最小子集/);
  });
});

describe('agent/output-guard：技能模板渲染', () => {
  it('槽位填充 + 保留槽 {{rules}} + 可选槽缺省文案 + 必填缺失抛错', async () => {
    const store = await loadPromptStore(REPO_ROOT);
    const skill = store.skills.get('generate_outline');
    expect(skill).toBeDefined();
    if (skill === undefined) return;
    const rendered = renderSkillPrompt(skill, { premise: '雨夜来电', format: '短剧' }, ['规则A']);
    expect(rendered).toContain('雨夜来电');
    expect(rendered).toContain('短剧');
    expect(rendered).toContain('（未指定）'); // scene_count optional 未给
    expect(rendered).not.toContain('{{premise}}');
    expect(() => renderSkillPrompt(skill, { format: '短剧' }, [])).toThrowError(/缺必填槽位/);
  });
});

describe('agent/output-guard：F1 三路径（E3 验收）', () => {
  async function setup() {
    const store = await loadPromptStore(REPO_ROOT);
    const skill = store.skills.get('generate_outline');
    if (skill === undefined) throw new Error('技能缺失');
    const schema = await loadSchema(REPO_ROOT, skill.meta.outputSchema);
    const tracer = createTracer({ runId: 'run-g', filePath: runFile }, { now: () => FIXED_NOW });
    return { skill, schema, tracer };
  }

  it('① 一次通过：validated，attempts=1，无 repair_event', async () => {
    const { skill, schema, tracer } = await setup();
    const { fetchFn } = cannedFetch([GOOD_JSON]);
    const result = await guardedSkillCall({
      tracer, gateway: gatewayWith(fetchFn), skill, schema,
      inputs: { premise: '雨夜来电', format: '短剧' }, rulesText: ['规则A'],
      now: () => FIXED_NOW,
    });
    expect(result.status).toBe('validated');
    expect(result.attempts).toBe(1);
    expect(result.output).toEqual({ scenes: [{ scene_id: '010', summary: '雨夜来电' }] });
    const events = parseTraceJsonl(readFileSync(runFile, 'utf8'));
    expect(events.map((e) => e.kind)).toEqual(['llm_call']);
    expect(events[0]).toMatchObject({ skill: 'generate_outline@1' });
  });

  it('② 重试后通过：第二次请求携带校验错误反馈；repair_event F1/recovered', async () => {
    const { skill, schema, tracer } = await setup();
    const { fetchFn, bodies } = cannedFetch([SCHEMA_BAD_JSON, GOOD_JSON]);
    const result = await guardedSkillCall({
      tracer, gateway: gatewayWith(fetchFn), skill, schema,
      inputs: { premise: '雨夜来电', format: '短剧' }, rulesText: ['规则A'],
      now: () => FIXED_NOW,
    });
    expect(result.status).toBe('validated');
    expect(result.attempts).toBe(2);
    expect(bodies[1]).toContain('上次输出未通过校验');
    expect(bodies[1]).toContain('/scenes/0/scene_id');
    const events = parseTraceJsonl(readFileSync(runFile, 'utf8'));
    expect(events.map((e) => e.kind)).toEqual(['llm_call', 'llm_call', 'repair_event']);
    expect(events[2]).toMatchObject({ failure_code: 'F1', result: 'recovered' });
  });

  it('③ 重试 2 次仍失败：degraded（纯文本草稿 + 需人工确认），repair_event F1/degraded', async () => {
    const { skill, schema, tracer } = await setup();
    const { fetchFn } = cannedFetch([BAD_JSON, BAD_JSON, BAD_JSON]);
    const result = await guardedSkillCall({
      tracer, gateway: gatewayWith(fetchFn), skill, schema,
      inputs: { premise: '雨夜来电', format: '短剧' }, rulesText: ['规则A'],
      now: () => FIXED_NOW,
    });
    expect(result.status).toBe('degraded');
    expect(result.attempts).toBe(3);
    expect(result.draftText).toBe(BAD_JSON);
    const events = parseTraceJsonl(readFileSync(runFile, 'utf8'));
    expect(events.filter((e) => e.kind === 'llm_call')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ failure_code: 'F1', result: 'degraded' });
  });

  it('F3 供应商失败不属于 F1：原样上抛，只落 F3 repair_event', async () => {
    const { skill, schema, tracer } = await setup();
    const fetchFn = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(
      guardedSkillCall({
        tracer,
        gateway: gatewayWith(fetchFn),
        skill, schema,
        inputs: { premise: '雨夜来电', format: '短剧' }, rulesText: ['规则A'],
        now: () => FIXED_NOW,
      }),
    ).rejects.toMatchObject({ code: 'SW-E040' });
    const events = parseTraceJsonl(readFileSync(runFile, 'utf8'));
    expect(events.map((e) => e.kind)).toEqual(['repair_event']);
    expect(events[0]).toMatchObject({ failure_code: 'F3', result: 'failed' });
  });
});
