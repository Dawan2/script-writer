/**
 * Agent 层·trace 脱敏摘要导出（TASK-P3-04，P3 方案 §2.7 规则 3）。
 *
 * 用途：把指定 run 的 JSONL 固化为 docs/evidence/ 可归档的 Markdown 摘要——
 * 对外归档一律用本函数产出（衔接 BLK-W1-03 的 CI 归档方向）。
 *
 * 摘要口径：事件计数、llm_call 成本汇总（token/延迟/attempts）、涉及的技能
 * （id@version）与模型、修复事件结果分布。**不含**任何正文全文与凭据——
 * 产出文本统一过 redactSecrets（秘密集由调用方显式给出）。
 */

import { redactSecrets } from '../gateway/redact.js';
import type { TraceEvent } from './types.js';

/** 解析 JSONL 文本为事件数组（空行跳过；行级坏 JSON 抛错带行号）。 */
export function parseTraceJsonl(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? '';
    if (line === '') continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      throw new Error(`trace JSONL 第 ${i + 1} 行不是合法 JSON`);
    }
  }
  return events;
}

/** 生成脱敏摘要（Markdown；secrets 中的任何值不得出现在产出中）。 */
export function summarizeRun(
  runId: string,
  events: readonly TraceEvent[],
  secrets: readonly string[] = [],
): string {
  const counts = new Map<string, number>();
  const skills = new Set<string>();
  const models = new Set<string>();
  let promptTokens = 0;
  let completionTokens = 0;
  let latencyMs = 0;
  let llmCalls = 0;
  const repairs = new Map<string, number>();

  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
    if (event.kind === 'llm_call') {
      llmCalls += 1;
      promptTokens += event.prompt_tokens ?? 0;
      completionTokens += event.completion_tokens ?? 0;
      latencyMs += event.latency_ms;
      if (event.skill !== undefined) skills.add(event.skill);
      models.add(event.model);
    }
    if (event.kind === 'repair_event') {
      const key = `${event.failure_code}/${event.result}`;
      repairs.set(key, (repairs.get(key) ?? 0) + 1);
    }
  }

  const endStatus = events.find((e) => e.kind === 'run_end')?.status ?? '（无 run_end）';
  const lines = [
    `# 运行脱敏摘要：${runId}`,
    '',
    `- 终态：${endStatus}`,
    `- 事件计数：${[...counts.entries()].map(([k, n]) => `${k} ×${n}`).join('、') || '（无）'}`,
    `- 模型调用：${llmCalls} 次；prompt_tokens 合计 ${promptTokens}；completion_tokens 合计 ${completionTokens}；延迟合计 ${latencyMs}ms`,
    `- 涉及技能：${[...skills].join('、') || '（无）'}；涉及模型：${[...models].join('、') || '（无）'}`,
    `- 修复事件：${[...repairs.entries()].map(([k, n]) => `${k} ×${n}`).join('、') || '（无）'}`,
    '',
    '> 本摘要为脱敏归档形态：不含剧本正文全文（仅 trace 内的槽位引用计数），不含任何凭据。',
  ];
  return redactSecrets(`${lines.join('\n')}\n`, secrets);
}
