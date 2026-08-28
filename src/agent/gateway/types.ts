/**
 * Agent 层·模型网关公共类型（TASK-P3-01，P3 方案 §2 架构图「模型网关层」）。
 *
 * 定位：全库**唯一**的模型调用出口。任何层（编排/工具/CLI）要调模型，只能经
 * `createGateway()` 拿到的 `ModelGateway.call()`——禁止直接 import provider 适配器
 * 或裸 fetch 模型端点（评审清单拦截，同 SPEC-03 fail() 纪律）。
 *
 * 本任务交付回放模式半程（方案 R-2：BLK-W1-02 凭据未定，验收 E4 真实调用待凭据到位
 * 后补证据）；所有外部效应（fetch / sleep / 时钟 / 环境变量）全注入，测试零网络。
 */

/** 对话消息（OpenAI 兼容形态，供应商差异由适配器内部消化）。 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** 一次模型调用的请求（网关入参；model 缺省走 config.model）。 */
export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/** 一次模型调用的成功响应（content 为纯文本正文；token 计数供 trace 成本汇总）。 */
export interface ModelResponse {
  readonly content: string;
  /** 实际出产的模型（fallback 切换后与请求 model 不同，trace 记这个）。 */
  readonly model: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

/** 供应商失败的归类（F3 策略表的机器可读形态）。 */
export type ProviderErrorKind =
  | 'timeout'
  | 'network'
  | 'http-429'
  | 'http-5xx'
  | 'http-4xx'
  | 'invalid-response'
  | 'fixture-miss';

/**
 * 供应商层错误（网关内部载体，非用户可见错误——用户可见面只有 SW-E040/E041，
 * 经 fail() 抛出；本类型不携带任何凭据，message 已经过 redactSecrets）。
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  /** F3：是否进入指数退避重试（timeout/network/429/5xx = true；4xx/响应非法/夹具缺失 = false）。 */
  readonly retryable: boolean;

  constructor(kind: ProviderErrorKind, message: string, options: { status?: number } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status;
    this.retryable =
      kind === 'timeout' || kind === 'network' || kind === 'http-429' || kind === 'http-5xx';
  }
}

/** 供应商适配器接口：单次调用、不重试（重试是网关层职责，F3 策略单点）。 */
export interface ProviderAdapter {
  readonly id: string;
  /** 发起一次请求；signal 触发时必须以 ProviderError('timeout') 拒绝（网关超时由 abort 实现）。 */
  complete(request: {
    model: string;
    messages: readonly ChatMessage[];
    maxTokens?: number;
    temperature?: number;
    signal: AbortSignal;
  }): Promise<ModelResponse>;
}

/** 网关配置（来源：环境变量，见 gatewayConfigFromEnv；凭据只存内存，永不落盘）。 */
export interface GatewayConfig {
  /** 供应商选择：replay = 夹具回放（无凭据开发/测试）；openai-compatible = 真实端点。 */
  readonly provider: 'replay' | 'openai-compatible';
  /** 仅 openai-compatible：API Key（SW_LLM_API_KEY 注入）。 */
  readonly apiKey?: string;
  /** 仅 openai-compatible：端点基址（SW_LLM_BASE_URL，缺省 https://api.openai.com/v1）。 */
  readonly baseUrl?: string;
  /** 主模型（SW_LLM_MODEL，缺省 gpt-4o-mini）。 */
  readonly model: string;
  /** 备用模型（SW_LLM_FALLBACK_MODEL；F3：重试耗尽后切换一次）。 */
  readonly fallbackModel?: string;
  /** 单次请求超时毫秒（缺省 30_000）。 */
  readonly timeoutMs: number;
  /** F3 退避重试次数上限（缺省 3，即最多 1+3 次尝试）。 */
  readonly maxRetries: number;
  /** F3 退避基数毫秒（第 n 次退避 = base × 2^(n-1)，缺省 500）。 */
  readonly backoffBaseMs: number;
  /** 仅 replay：夹具目录（SW_LLM_REPLAY_DIR；缺夹具 = ProviderError('fixture-miss')）。 */
  readonly replayDir?: string;
}

/** 网关可注入依赖（测试缝：fetch / 退避 sleep / 时钟全注入，零网络零真睡）。 */
export interface GatewayDeps {
  readonly fetchFn?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** 网关调用结果：响应 + 供 trace 的元数据（TASK-P3-04 llm_call 事件的数据源）。 */
export interface GatewayResult {
  readonly response: ModelResponse;
  /** 总尝试次数（含 fallback 切换后的尝试）。 */
  readonly attempts: number;
  /** 是否发生了 F3 备用模型切换。 */
  readonly fallbackUsed: boolean;
  /** 端到端延迟毫秒（由注入时钟测得）。 */
  readonly latencyMs: number;
}

/** 网关门面（唯一调用出口）。 */
export interface ModelGateway {
  call(request: ModelRequest): Promise<GatewayResult>;
}
