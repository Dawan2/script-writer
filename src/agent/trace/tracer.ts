/**
 * Agent 层·运行轨迹 tracer（TASK-P3-04 最小实现，P3 方案 §2.7）。
 *
 * 职责：把事件追加为 JSONL 行（runs/<run_id>.jsonl）；序列化每行前过 redactSecrets
 * （凭据永不落盘的强制点）；llm_call 自动累计成本口径，end() 落 run_end 汇总行。
 *
 * tracedLlmCall：网关调用的观测包装——成功落 llm_call；SW-E040（F3 兜底失败）
 * 额外落 repair_event(failure_code='F3', result='failed') 再上抛。这是网关与 trace
 * 的粘接点，编排层（TASK-P3-07 起）经此拿观测，不直接摸文件。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isSwError } from '../../app/errors/registry.js';
import type { ModelGateway, ModelRequest } from '../gateway/types.js';
import { redactSecrets } from '../gateway/redact.js';
import type { LlmCallEvent, LlmTotals, TraceEvent } from './types.js';

export interface TracerDeps {
  /** 注入时钟（ISO 输出）。 */
  now(): Date;
  /** 追加写（缺省 fs 语义：先建目录再 appendFile）。 */
  appendLine?(path: string, line: string): Promise<void>;
}

/** 默认追加写：目录缺失自动创建（runs/ 为 gitignore 瞬态件）。 */
async function defaultAppendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, 'utf8');
}

export interface Tracer {
  readonly runId: string;
  readonly filePath: string;
  /** 通用事件落盘（序列化前脱敏）。 */
  emit(event: TraceEvent): Promise<void>;
  /** 落 run_start。 */
  start(requestType: 'workflow' | 'freeform', workflowId?: string): Promise<void>;
  /** 落 run_end（totals 缺省用累计值；status 默认 done）。 */
  end(status?: 'done' | 'failed', totals?: LlmTotals): Promise<void>;
  /** 当前 llm_call 累计（run_end 缺省数据源，也供摘要导出复用）。 */
  totals(): LlmTotals;
  /** llm_call 累计加一（tracedLlmCall 与外部共用）。 */
  accumulate(call: Pick<LlmCallEvent, 'prompt_tokens' | 'completion_tokens' | 'latency_ms'>): void;
}

export function createTracer(
  options: { runId: string; filePath: string; secrets?: readonly string[] },
  deps: TracerDeps = { now: () => new Date() },
): Tracer {
  const secrets = options.secrets ?? [];
  const appendLine = deps.appendLine ?? defaultAppendLine;
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let latencyMs = 0;

  const tracer: Tracer = {
    runId: options.runId,
    filePath: options.filePath,

    async emit(event) {
      const line = `${redactSecrets(JSON.stringify(event), secrets)}\n`;
      await appendLine(options.filePath, line);
    },

    start(requestType, workflowId) {
      return tracer.emit({
        run_id: options.runId,
        ts: deps.now().toISOString(),
        kind: 'run_start',
        request_type: requestType,
        ...(workflowId !== undefined ? { workflow_id: workflowId } : {}),
      });
    },

    end(status = 'done', totals) {
      return tracer.emit({
        run_id: options.runId,
        ts: deps.now().toISOString(),
        kind: 'run_end',
        status,
        totals: totals ?? tracer.totals(),
      });
    },

    totals: () => ({
      llm_calls: calls,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      latency_ms: latencyMs,
    }),

    accumulate(call) {
      calls += 1;
      promptTokens += call.prompt_tokens ?? 0;
      completionTokens += call.completion_tokens ?? 0;
      latencyMs += call.latency_ms;
    },
  };
  return tracer;
}

/**
 * 网关调用的观测包装：成功 → llm_call + 累计；SW-E040 → repair_event(F3, failed) 后原样上抛。
 */
export async function tracedLlmCall(
  tracer: Tracer,
  gateway: ModelGateway,
  request: ModelRequest,
  meta: {
    skill?: string;
    contextSlots?: Readonly<Record<string, readonly string[]>>;
    now?: () => Date;
  } = {},
): Promise<Awaited<ReturnType<ModelGateway['call']>>> {
  const now = meta.now ?? (() => new Date());
  try {
    const result = await gateway.call(request);
    const event: LlmCallEvent = {
      run_id: tracer.runId,
      ts: now().toISOString(),
      kind: 'llm_call',
      ...(meta.skill !== undefined ? { skill: meta.skill } : {}),
      model: result.response.model,
      ...(result.response.promptTokens !== undefined
        ? { prompt_tokens: result.response.promptTokens }
        : {}),
      ...(result.response.completionTokens !== undefined
        ? { completion_tokens: result.response.completionTokens }
        : {}),
      latency_ms: result.latencyMs,
      attempts: result.attempts,
      fallback_used: result.fallbackUsed,
      ...(meta.contextSlots !== undefined ? { context_slots: meta.contextSlots } : {}),
    };
    await tracer.emit(event);
    tracer.accumulate(event);
    return result;
  } catch (error) {
    if (isSwError(error) && error.code === 'SW-E040') {
      await tracer.emit({
        run_id: tracer.runId,
        ts: now().toISOString(),
        kind: 'repair_event',
        failure_code: 'F3',
        strategy: '指数退避 + 备用模型切换（均已用尽）',
        result: 'failed',
      });
    }
    throw error;
  }
}
