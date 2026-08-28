/**
 * trace 最小实现测试（TASK-P3-04）。
 * 粘接演示：回放网关 + tracer 走一次完整 run（run_start → llm_call → run_end），
 * 断言 JSONL 四件最小事件字段齐全；F3 失败路径落 repair_event；摘要导出无凭据无正文。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGateway } from '../../src/agent/gateway/gateway.js';
import { replayFingerprint } from '../../src/agent/gateway/providers/replay.js';
import { createTracer, tracedLlmCall } from '../../src/agent/trace/tracer.js';
import { parseTraceJsonl, summarizeRun } from '../../src/agent/trace/summary.js';
import type { ChatMessage } from '../../src/agent/gateway/types.js';

const MESSAGES: readonly ChatMessage[] = [{ role: 'user', content: '生成大纲' }];
const SECRET = 'sk-testkey-trace-1';

let dir: string;
let replayDir: string;
let runFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-trace-'));
  replayDir = join(dir, 'fixtures');
  runFile = join(dir, 'runs', 'run-001.jsonl');
  mkdirSync(replayDir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FIXED_NOW = new Date('2026-08-28T08:00:00.000Z');

function replayGateway() {
  return createGateway(
    { provider: 'replay', model: 'm1', timeoutMs: 100, maxRetries: 0, backoffBaseMs: 1, replayDir },
  );
}

describe('agent/trace：JSONL 事件落盘（E4 最小事件集）', () => {
  it('完整 run：run_start → llm_call（token/延迟/技能版本/槽位引用）→ run_end（汇总）', async () => {
    writeFileSync(
      join(replayDir, `${replayFingerprint('m1', MESSAGES)}.json`),
      JSON.stringify({ content: '大纲正文', promptTokens: 4200, completionTokens: 800 }),
    );
    const t = createTracer(
      { runId: 'run-001', filePath: runFile, secrets: [SECRET] },
      { now: () => FIXED_NOW },
    );
    await t.start('workflow', 'WF-01');
    await tracedLlmCall(t, replayGateway(), { messages: MESSAGES }, {
      skill: 'generate_outline@1',
      contextSlots: { script: ['010#summary'] },
      now: () => FIXED_NOW,
    });
    await t.end();

    const events = parseTraceJsonl(readFileSync(runFile, 'utf8'));
    expect(events.map((e) => e.kind)).toEqual(['run_start', 'llm_call', 'run_end']);

    const [start, call, end] = events;
    expect(start).toMatchObject({ run_id: 'run-001', request_type: 'workflow', workflow_id: 'WF-01' });
    expect(call).toMatchObject({
      kind: 'llm_call',
      skill: 'generate_outline@1', // 版本化引用（TASK-P3-02 佐证位）
      model: 'm1',
      prompt_tokens: 4200,
      completion_tokens: 800,
      attempts: 1,
      fallback_used: false,
      context_slots: { script: ['010#summary'] },
    });
    expect(end).toMatchObject({
      kind: 'run_end',
      status: 'done',
      totals: { llm_calls: 1, prompt_tokens: 4200, completion_tokens: 800 },
    });
    for (const e of events) expect(e.ts).toBe('2026-08-28T08:00:00.000Z');
  });

  it('F3 兜底失败：repair_event(failed) 落盘且错误原样上抛；run_end(failed)', async () => {
    const t = createTracer(
      { runId: 'run-001', filePath: runFile },
      { now: () => FIXED_NOW },
    );
    await t.start('freeform');
    await expect(tracedLlmCall(t, replayGateway(), { messages: MESSAGES })).rejects.toMatchObject({
      code: 'SW-E040',
    });
    await t.end('failed');

    const events = parseTraceJsonl(readFileSync(runFile, 'utf8'));
    expect(events.map((e) => e.kind)).toEqual(['run_start', 'repair_event', 'run_end']);
    expect(events[1]).toMatchObject({ failure_code: 'F3', result: 'failed' });
    expect(events[2]).toMatchObject({ status: 'failed', totals: { llm_calls: 0 } });
  });

  it('凭据混进事件字段也不落盘：emit 前 redactSecrets 强制抹除', async () => {
    const t = createTracer(
      { runId: 'run-001', filePath: runFile, secrets: [SECRET] },
      { now: () => FIXED_NOW },
    );
    await t.emit({
      run_id: 'run-001',
      ts: FIXED_NOW.toISOString(),
      kind: 'repair_event',
      failure_code: 'F3',
      strategy: `调试回显 ${SECRET}`,
      result: 'failed',
    });
    const raw = readFileSync(runFile, 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('***');
  });
});

describe('agent/trace：脱敏摘要导出（E3）', () => {
  it('摘要含计数/成本/技能版本/修复分布；无凭据、无正文全文', async () => {
    const jsonl = [
      JSON.stringify({ run_id: 'r', ts: 't', kind: 'run_start', request_type: 'workflow', workflow_id: 'WF-01' }),
      JSON.stringify({
        run_id: 'r', ts: 't', kind: 'llm_call', skill: 'generate_outline@1', model: 'm1',
        prompt_tokens: 100, completion_tokens: 50, latency_ms: 300, attempts: 1, fallback_used: false,
        context_slots: { script: ['010#summary'] },
      }),
      JSON.stringify({ run_id: 'r', ts: 't', kind: 'repair_event', failure_code: 'F1', strategy: 'x', result: 'recovered' }),
      JSON.stringify({ run_id: 'r', ts: 't', kind: 'run_end', status: 'done', totals: { llm_calls: 1, prompt_tokens: 100, completion_tokens: 50, latency_ms: 300 } }),
    ].join('\n');
    const md = summarizeRun('r', parseTraceJsonl(jsonl), [SECRET]);
    expect(md).toContain('llm_call ×1');
    expect(md).toContain('generate_outline@1');
    expect(md).toContain('F1/recovered ×1');
    expect(md).toContain('prompt_tokens 合计 100');
    expect(md).not.toContain(SECRET);
    // 剧本正文不出现（trace 只存槽位引用，摘要连引用也不列明细）
    expect(md).not.toContain('010#summary');
  });

  it('行级坏 JSON 抛错带行号；空行跳过', () => {
    expect(() => parseTraceJsonl('{"a":1}\n{broken}\n')).toThrowError(/第 2 行/);
    expect(parseTraceJsonl('\n{"run_id":"r","ts":"t","kind":"run_start","request_type":"freeform"}\n\n')).toHaveLength(1);
  });
});
