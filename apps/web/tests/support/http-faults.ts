import { registerTeardown } from "./lifecycle";

const BASE_ORIGIN = "http://localhost:3000";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** 一次请求的记录，供测试断言调用次数、顺序与请求内容。 */
export interface RequestRecord {
  method: string;
  /** 完整 URL（相对地址会补上 http://localhost:3000）。 */
  url: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  /** 请求体是字符串时的原文，否则为 null。 */
  bodyText: string | null;
  /** 请求体是 FormData 或 URLSearchParams 时的字段，否则为 null。 */
  bodyFields: Record<string, string> | null;
  /** 该路由上的第几次调用，从 1 开始。 */
  callIndex: number;
  /** 请求是否在响应前被调用方取消。 */
  aborted: boolean;
}

interface ResponseInitLike {
  status?: number;
  headers?: Record<string, string>;
  /** 响应前的等待时长；装了可控时钟时由 advance 驱动。 */
  delayMs?: number;
}

type Fault =
  | { kind: "body"; status: number; headers: Record<string, string>; body: string; delayMs: number }
  | { kind: "networkError"; message: string; delayMs: number }
  | { kind: "timeout" };

/** 正常响应：JSON 响应体。 */
export function json(body: unknown, init: ResponseInitLike = {}): Fault {
  return {
    kind: "body",
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    delayMs: init.delayMs ?? 0
  };
}

/** 正常响应：纯文本响应体。 */
export function text(body: string, init: ResponseInitLike = {}): Fault {
  return {
    kind: "body",
    status: init.status ?? 200,
    headers: { "content-type": "text/plain; charset=utf-8", ...(init.headers ?? {}) },
    body,
    delayMs: init.delayMs ?? 0
  };
}

/** 失败响应：给定状态码，响应体按 JSON 返回。 */
export function failure(status: number, body: unknown = {}, init: ResponseInitLike = {}): Fault {
  return json(body, { ...init, status });
}

/** 畸形响应：状态码正常但响应体不是合法 JSON，用于验证解析失败的兜底。 */
export function malformed(init: ResponseInitLike & { body?: string } = {}): Fault {
  return {
    kind: "body",
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body ?? '{"detail": "响应在传输中被截断',
    delayMs: init.delayMs ?? 0
  };
}

/** 网络失败：fetch 直接抛错，等同于断网、DNS 失败、连接被重置。 */
export function networkError(message = "Failed to fetch", init: ResponseInitLike = {}): Fault {
  return { kind: "networkError", message, delayMs: init.delayMs ?? 0 };
}

/** 超时：响应永不返回，只有调用方自己取消（AbortSignal）才会结束。 */
export function timeout(): Fault {
  return { kind: "timeout" };
}

export interface RoutePattern {
  method?: HttpMethod | "*";
  path?: string | RegExp;
  /** 需要匹配的查询参数子集。 */
  query?: Record<string, string>;
}

export interface RouteHandle {
  /** 该路由的所有调用都返回同一响应。 */
  always(fault: Fault): RouteHandle;
  /** 按调用次序返回响应：第 1 次用第 1 个，第 2 次用第 2 个，以此类推。 */
  sequence(...faults: Fault[]): RouteHandle;
  /** 只覆盖第 n 次调用（n 从 1 开始），其余调用仍走 always 或 sequence。 */
  onCall(n: number, fault: Fault): RouteHandle;
  /** 该路由收到的请求记录。 */
  calls(): RequestRecord[];
  callCount(): number;
}

export interface HttpFaults {
  /** 声明一条路由。同一模式重复调用返回同一句柄，可继续追加规则。 */
  route(pattern: string | RoutePattern): RouteHandle;
  /** 全部请求记录，按发生顺序。 */
  calls(): RequestRecord[];
  /** 没有匹配到任何路由的请求。 */
  unmatched(): RequestRecord[];
  /** 提前还原真实 fetch；通常不必调用，测试结束会自动还原。 */
  uninstall(): void;
}

export interface HttpFaultsOptions {
  /**
   * 默认 false：测试结束时若出现未声明的请求会直接失败，避免代码把异常吞掉后测试假通过。
   */
  allowUnmatched?: boolean;
}

interface Route {
  label: string;
  method: string;
  matchPath: (path: string) => boolean;
  query?: Record<string, string>;
  always?: Fault;
  sequence?: Fault[];
  onCall: Map<number, Fault>;
  records: RequestRecord[];
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"]);

function parsePattern(pattern: string | RoutePattern): { label: string; method: string; path: string | RegExp; query?: Record<string, string> } {
  if (typeof pattern !== "string") {
    return {
      label: `${pattern.method ?? "*"} ${String(pattern.path ?? "**")}`,
      method: (pattern.method ?? "*").toUpperCase(),
      path: pattern.path ?? "**",
      query: pattern.query
    };
  }
  const trimmed = pattern.trim();
  const spaceAt = trimmed.indexOf(" ");
  const head = spaceAt === -1 ? "" : trimmed.slice(0, spaceAt).toUpperCase();
  if (!METHODS.has(head)) {
    throw new Error(`路由模式需要写成「方法 路径」，例如 "GET /api/projects"，收到：${pattern}`);
  }
  const rest = trimmed.slice(spaceAt + 1).trim();
  const questionAt = rest.indexOf("?");
  if (questionAt === -1) return { label: `${head} ${rest}`, method: head, path: rest };
  const path = rest.slice(0, questionAt);
  const query = Object.fromEntries(new URLSearchParams(rest.slice(questionAt + 1)));
  return { label: `${head} ${rest}`, method: head, path, query };
}

function buildPathMatcher(path: string | RegExp): (candidate: string) => boolean {
  if (path instanceof RegExp) return (candidate) => path.test(candidate);
  // `*` 匹配单个路径段，`**` 匹配任意层级。
  const source = path
    .split("**")
    .map((part) => part.split("*").map(escapeRegExp).join("[^/]*"))
    .join(".*");
  const regex = new RegExp(`^${source}$`);
  return (candidate) => regex.test(candidate);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readHeaders(init: RequestInit | undefined, request: Request | null): Record<string, string> {
  const result: Record<string, string> = {};
  const source = init?.headers ?? request?.headers;
  if (!source) return result;
  if (typeof Headers !== "undefined" && source instanceof Headers) {
    source.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }
  if (Array.isArray(source)) {
    for (const [key, value] of source) result[String(key).toLowerCase()] = String(value);
    return result;
  }
  for (const [key, value] of Object.entries(source as Record<string, string>)) {
    result[key.toLowerCase()] = String(value);
  }
  return result;
}

function readBody(body: BodyInit | null | undefined): Pick<RequestRecord, "bodyText" | "bodyFields"> {
  if (body == null) return { bodyText: null, bodyFields: null };
  if (typeof body === "string") return { bodyText: body, bodyFields: null };
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const fields: Record<string, string> = {};
    body.forEach((value, key) => {
      fields[key] = typeof value === "string" ? value : `[file:${(value as File).name}]`;
    });
    return { bodyText: null, bodyFields: fields };
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return { bodyText: body.toString(), bodyFields: Object.fromEntries(body) };
  }
  return { bodyText: null, bodyFields: null };
}

function abortError(signal: AbortSignal): Error {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const error = new Error("请求已取消");
  error.name = "AbortError";
  return error;
}

function settleAfterDelay<T>(delayMs: number, signal: AbortSignal | null, produce: () => T): Promise<T> {
  if (delayMs <= 0) {
    // 无延迟时不排定时器：可控时钟正在推进的那一刻新排的 0 毫秒定时器不会在同一次推进里触发。
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return Promise.resolve(produce());
  }
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    if (signal) {
      if (signal.aborted) {
        reject(abortError(signal));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // 延迟走全局定时器，装上可控时钟后由 clock.advance 驱动。
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(produce());
    }, delayMs);
  });
}

/**
 * 安装请求故障注入：接管 globalThis.fetch，按接口与第几次调用返回延迟、失败、超时、畸形响应。
 */
export function installHttpFaults(options: HttpFaultsOptions = {}): HttpFaults {
  const routes: Route[] = [];
  const allCalls: RequestRecord[] = [];
  const unmatchedCalls: RequestRecord[] = [];
  const original = globalThis.fetch;

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const rawUrl = request ? request.url : String(input);
    const url = new URL(rawUrl, BASE_ORIGIN);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const signal = init?.signal ?? request?.signal ?? null;

    const route = routes.find(
      (candidate) =>
        (candidate.method === "*" || candidate.method === method) &&
        candidate.matchPath(url.pathname) &&
        matchesQuery(candidate.query, url.searchParams)
    );

    const record: RequestRecord = {
      method,
      url: url.toString(),
      path: url.pathname,
      search: url.search,
      headers: readHeaders(init, request),
      ...readBody(init?.body ?? null),
      callIndex: route ? route.records.length + 1 : unmatchedCalls.length + 1,
      aborted: false
    };
    allCalls.push(record);
    signal?.addEventListener("abort", () => {
      record.aborted = true;
    });

    if (!route) {
      unmatchedCalls.push(record);
      throw new Error(
        `测试未声明这个请求：${method} ${url.pathname}${url.search}\n` +
          `已声明的路由：${routes.length ? routes.map((item) => item.label).join("、") : "（无）"}`
      );
    }

    route.records.push(record);
    const fault = resolveFault(route, record.callIndex);

    if (fault.kind === "timeout") {
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return; // 永不返回：调用方没有取消手段时即为挂死
        if (signal.aborted) {
          reject(abortError(signal));
          return;
        }
        signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
      });
    }

    if (fault.kind === "networkError") {
      await settleAfterDelay(fault.delayMs, signal, () => undefined);
      throw new TypeError(fault.message);
    }

    return settleAfterDelay(
      fault.delayMs,
      signal,
      () => new Response(fault.body, { status: fault.status, headers: fault.headers })
    );
  };

  globalThis.fetch = impl as typeof globalThis.fetch;

  let installed = true;
  const uninstall = () => {
    if (!installed) return;
    installed = false;
    globalThis.fetch = original;
  };
  registerTeardown(() => {
    uninstall();
    if (!options.allowUnmatched && unmatchedCalls.length) {
      const lines = unmatchedCalls.map((item) => `${item.method} ${item.path}${item.search}`);
      throw new Error(
        `出现 ${unmatchedCalls.length} 个未声明的请求，测试可能吞掉了异常：\n${lines.join("\n")}`
      );
    }
  });

  return {
    route(pattern) {
      const parsed = parsePattern(pattern);
      const existing = routes.find((item) => item.label === parsed.label);
      if (existing) return makeHandle(existing);
      const route: Route = {
        label: parsed.label,
        method: parsed.method,
        matchPath: buildPathMatcher(parsed.path),
        query: parsed.query,
        onCall: new Map(),
        records: []
      };
      routes.push(route);
      return makeHandle(route);
    },
    calls: () => [...allCalls],
    unmatched: () => [...unmatchedCalls],
    uninstall
  };
}

function matchesQuery(expected: Record<string, string> | undefined, actual: URLSearchParams): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([key, value]) => actual.get(key) === value);
}

function resolveFault(route: Route, callIndex: number): Fault {
  const override = route.onCall.get(callIndex);
  if (override) return override;
  if (route.sequence) {
    const fault = route.sequence[callIndex - 1];
    if (fault) return fault;
  }
  if (route.always) return route.always;
  throw new Error(
    `路由「${route.label}」的第 ${callIndex} 次调用没有预设响应，请补 always()、sequence() 或 onCall()`
  );
}

function makeHandle(route: Route): RouteHandle {
  const handle: RouteHandle = {
    always(fault) {
      route.always = fault;
      return handle;
    },
    sequence(...faults) {
      route.sequence = faults;
      return handle;
    },
    onCall(n, fault) {
      if (!Number.isInteger(n) || n < 1) throw new Error(`onCall 的次序从 1 开始，收到：${n}`);
      route.onCall.set(n, fault);
      return handle;
    },
    calls: () => [...route.records],
    callCount: () => route.records.length
  };
  return handle;
}
