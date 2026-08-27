import { ApiError, apiErrorFromResponse, apiErrorFromTransport, isApiError } from "@/lib/api-error";
import {
  CLIENT_TIMEOUT_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  budgetOf,
  newTraceId,
  webTraceId,
  type BudgetKey
} from "@/lib/request-budget";
import { CLIENT_ERROR_CODES } from "@/lib/error-codes";

/**
 * 浏览器侧唯一的 fetch 出口：预算、取消、只读退避、信封解析、追踪号、幂等键透传都收在这里。
 * 业务接口模块（api-client.ts、admin-api.ts）一律经本模块发请求，不再各自持有裸 fetch。
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** 任意接口函数都接受的末位选项。 */
export interface RequestOptions {
  /** 组件卸载或用户切走时用来取消本次请求，见 use-request-scope.ts。 */
  signal?: AbortSignal;
  /** 幂等键：只透传给后端，核心不生成、不去重、不自动重发。 */
  idempotencyKey?: string;
}

interface CoreRequest extends RequestOptions {
  method?: HttpMethod;
  /** JSON 请求体。 */
  json?: unknown;
  /** 表单请求体，用于上传。 */
  form?: FormData;
  /** 预算覆盖档；缺省按方法与请求体推断。 */
  budget?: BudgetKey;
}

/** 调用方主动取消：不是一次失败，不占错误码，也不该在界面上留下任何提示。 */
export class RequestCancelledError extends Error {
  constructor() {
    super("请求已取消");
    this.name = "RequestCancelled";
  }
}

export function isRequestCancelled(error: unknown): error is RequestCancelledError {
  return error instanceof RequestCancelledError;
}

/** 只读退避的两档间隔，不写公式。 */
const READ_RETRY_DELAYS_MS = [500, 1500] as const;
/** 只有网关级的这三个状态码才退避重试。 */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

export type ConnectionState = "reachable" | "unreachable";

const authFailureHandlers = new Set<(error: ApiError) => void>();
const connectionListeners = new Set<(state: ConnectionState) => void>();
let lastConnectionState: ConnectionState | null = null;

/**
 * 会话失效的广播出口（供 C1-W1-04）。只广播 category 为 auth 的失败，
 * 不跳转、不弹登录框、不重放失败请求；没有处理器时行为与现在一致。
 */
export function onAuthFailure(handler: (error: ApiError) => void): () => void {
  authFailureHandlers.add(handler);
  return () => authFailureHandlers.delete(handler);
}

/**
 * 连接状态的广播出口（供 C1-W1-12）。只广播由请求结果得出的状态，
 * 不读 navigator.onLine、不排队、不做界面。
 */
export function onConnectionChange(listener: (state: ConnectionState) => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

function publishConnectionState(state: ConnectionState) {
  if (lastConnectionState === state) return;
  lastConnectionState = state;
  for (const listener of [...connectionListeners]) listener(state);
}

function publishFailure(error: unknown) {
  if (!isApiError(error)) return;
  if (error.code === CLIENT_ERROR_CODES.BACKEND_UNREACHABLE || error.code === CLIENT_ERROR_CODES.BACKEND_TIMEOUT) {
    publishConnectionState("unreachable");
  }
  if (error.category === "auth") {
    for (const handler of [...authFailureHandlers]) handler(error);
  }
}

function defaultBudget(method: HttpMethod, form: FormData | undefined): BudgetKey {
  if (form) return "upload";
  return method === "GET" ? "read" : "write";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface Attempt {
  response: Response | null;
  /** 一次响应都没拿到。 */
  unreachable: boolean;
  /** 本次预算到期。 */
  timedOut: boolean;
}

async function sendOnce(
  path: string,
  request: CoreRequest,
  traceId: string,
  remainingMs: number | null
): Promise<Attempt> {
  const method = request.method ?? "GET";
  const headers = new Headers();
  headers.set(REQUEST_ID_HEADER, traceId);
  if (request.json !== undefined) headers.set("content-type", "application/json");
  if (request.idempotencyKey) headers.set(IDEMPOTENCY_KEY_HEADER, request.idempotencyKey);
  const budget = budgetOf(request.budget ?? defaultBudget(method, request.form));
  if (budget.browserMs !== null) headers.set(CLIENT_TIMEOUT_HEADER, String(budget.browserMs));

  const controller = new AbortController();
  let timedOut = false;
  const abortByCaller = () => controller.abort();
  request.signal?.addEventListener("abort", abortByCaller, { once: true });
  const timer =
    remainingMs === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, remainingMs);

  try {
    const response = await fetch(path, {
      method,
      headers,
      body: request.form ?? (request.json === undefined ? undefined : JSON.stringify(request.json)),
      signal: controller.signal,
      cache: "no-store"
    });
    return { response, unreachable: false, timedOut: false };
  } catch {
    if (request.signal?.aborted) throw new RequestCancelledError();
    return { response: null, unreachable: !timedOut, timedOut };
  } finally {
    if (timer !== null) clearTimeout(timer);
    request.signal?.removeEventListener("abort", abortByCaller);
  }
}

async function send(path: string, request: CoreRequest): Promise<{ response: Response; traceId: string }> {
  const method = request.method ?? "GET";
  const budget = budgetOf(request.budget ?? defaultBudget(method, request.form));
  const traceId = newTraceId();
  const deadlineAt = budget.browserMs === null ? null : Date.now() + budget.browserMs;
  // 写操作在任何情况下都不被核心自动重发，带幂等键也不重发。
  const retriesAllowed = method === "GET" ? READ_RETRY_DELAYS_MS.length : 0;

  if (request.signal?.aborted) throw new RequestCancelledError();

  for (let attempt = 0; ; attempt += 1) {
    const remainingMs = deadlineAt === null ? null : deadlineAt - Date.now();
    if (remainingMs !== null && remainingMs <= 0) {
      throw apiErrorFromTransport("timeout", webTraceId(traceId));
    }

    const outcome = await sendOnce(path, request, traceId, remainingMs);
    // 预算到期即停，超时之后不再重试。
    if (outcome.timedOut) throw apiErrorFromTransport("timeout", webTraceId(traceId));

    const shouldRetry =
      attempt < retriesAllowed &&
      (outcome.unreachable || (outcome.response !== null && GATEWAY_STATUSES.has(outcome.response.status)));

    if (!shouldRetry) {
      if (outcome.response === null) throw apiErrorFromTransport("unreachable", webTraceId(traceId));
      return { response: outcome.response, traceId };
    }

    const delayMs = READ_RETRY_DELAYS_MS[attempt];
    // 全部尝试共享同一个截止时间：退避会越过截止时间就不再等了。
    if (deadlineAt !== null && Date.now() + delayMs >= deadlineAt) {
      if (outcome.response === null) throw apiErrorFromTransport("unreachable", webTraceId(traceId));
      return { response: outcome.response, traceId };
    }
    await sleep(delayMs);
    if (request.signal?.aborted) throw new RequestCancelledError();
  }
}

/** 发一次请求并解析 JSON；失败时抛带错误码的 ApiError。 */
export async function requestJson<T>(path: string, request: CoreRequest = {}): Promise<T> {
  let sent: { response: Response; traceId: string };
  try {
    sent = await send(path, request);
  } catch (error) {
    publishFailure(error);
    throw error;
  }

  const { response, traceId } = sent;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 代理层没把追踪号复制回来时沿用浏览器这次生成的号：服务端中间件用的是同一个号。
    const error = apiErrorFromResponse(response.status, payload, response.headers.get(REQUEST_ID_HEADER) ?? traceId);
    publishFailure(error);
    throw error;
  }
  publishConnectionState("reachable");
  return payload as T;
}

/** 发一次请求但不读响应体，用于退出登录这类不看返回内容的操作。 */
export async function requestWithoutResult(path: string, request: CoreRequest = {}): Promise<void> {
  try {
    await send(path, request);
    publishConnectionState("reachable");
  } catch (error) {
    publishFailure(error);
    throw error;
  }
}
