/**
 * Agent 层·运行轨迹 trace 类型（TASK-P3-04 最小实现，P3 方案 §2.7）。
 *
 * 形态：JSONL 事件流，每行一个事件，按 run_id 聚合；运行期写 `runs/*.jsonl`
 * （gitignore，瞬态观测件非状态源）。最小事件集：run_start / run_end / llm_call /
 * repair_event（本任务四件）；其余事件类型（plan_created / step_* / tool_call /
 * clarify_event / human_gate）随编排层落地按需扩充——事件类型是开放集合，本文件
 * 只钉死四件的字段契约。
 *
 * 脱敏纪律（方案 §2.7 规则 1）：凭据永不落盘（tracer 序列化每行前过 redactSecrets）；
 * 剧本正文默认只存引用（context_slots 存「场号#粒度」指针，不存全文）。
 */

/** 事件公共字段。 */
interface TraceEventBase {
  readonly run_id: string;
  /** ISO 时间戳（注入时钟产出）。 */
  readonly ts: string;
  readonly kind: string;
}

/** 运行开始：一次 Agent 请求的入口（request 只存类型标识，不存用户正文全文）。 */
export interface RunStartEvent extends TraceEventBase {
  readonly kind: 'run_start';
  readonly request_type: 'workflow' | 'freeform';
  readonly workflow_id?: string;
}

/** 运行结束：含按 run 汇总的成本与延迟（方案规则 2：L4 数据基础，从第一天采集）。 */
export interface RunEndEvent extends TraceEventBase {
  readonly kind: 'run_end';
  readonly status: 'done' | 'failed';
  readonly totals: {
    readonly llm_calls: number;
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly latency_ms: number;
  };
}

/** 模型调用：网关 GatewayResult 的落盘形态（skill 恒为 id@version，版本回溯锚点）。 */
export interface LlmCallEvent extends TraceEventBase {
  readonly kind: 'llm_call';
  readonly skill?: string;
  readonly model: string;
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly latency_ms: number;
  readonly attempts: number;
  readonly fallback_used: boolean;
  readonly finish_reason?: string;
  /** 上下文槽位引用（场号+哈希/#summary|#full 指针），禁存正文全文。 */
  readonly context_slots?: Readonly<Record<string, readonly string[]>>;
}

/** 失败自修复事件（方案 §2.4：repair_event 是 L2「失败有兜底」的直接证据）。 */
export interface RepairEvent extends TraceEventBase {
  readonly kind: 'repair_event';
  /** 失败码（F1 输出格式 / F3 供应商 / 后续 F2/F4/F5 随编排层扩充）。 */
  readonly failure_code: string;
  /** 处置策略（如「指数退避×3→切换备用模型」）。 */
  readonly strategy: string;
  readonly result: 'recovered' | 'degraded' | 'failed';
}

export type TraceEvent = RunStartEvent | RunEndEvent | LlmCallEvent | RepairEvent;

/** llm_call 汇总口径（run_end.totals 与脱敏摘要共用）。 */
export interface LlmTotals {
  readonly llm_calls: number;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly latency_ms: number;
}
