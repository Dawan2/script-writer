import { cookies, headers as requestHeaders } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/constants";
import { CLIENT_ERROR_TEXT } from "@/lib/api-error";
import { CLIENT_ERROR_CODES } from "@/lib/error-codes";
import {
  CLIENT_TIMEOUT_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  proxyBudgetMs,
  webTraceId
} from "@/lib/request-budget";

export const API_BASE = process.env.API_BASE_URL ?? "http://127.0.0.1:8000";

/** 浏览器加的这几个头要带到后端：追踪号、幂等键、本次预算声明。 */
const FORWARDED_HEADERS = [REQUEST_ID_HEADER, IDEMPOTENCY_KEY_HEADER, CLIENT_TIMEOUT_HEADER] as const;

export interface BackendFetchOptions {
  /** 进展流这类本就不该有总超时的请求显式声明；请求头声明不了这件事。 */
  noTimeout?: boolean;
}

export async function sessionToken() {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value;
}

/** 后端连不上或代理层预算到期时，回给浏览器的信封，形状与服务端失败响应一致。 */
function synthesizedFailure(kind: "unreachable" | "timeout", traceId: string) {
  const code =
    kind === "timeout" ? CLIENT_ERROR_CODES.BACKEND_TIMEOUT : CLIENT_ERROR_CODES.BACKEND_UNREACHABLE;
  const body = {
    error: {
      code,
      category: "runtime",
      retryable: true,
      message: CLIENT_ERROR_TEXT[code].message,
      hint: CLIENT_ERROR_TEXT[code].hint,
      traceId
    }
  };
  return new Response(JSON.stringify(body), {
    status: kind === "timeout" ? 504 : 503,
    headers: {
      "content-type": "application/json",
      [REQUEST_ID_HEADER]: traceId
    }
  });
}

/**
 * 转发到 FastAPI 的唯一出口。
 * 连不上或超时时返回合成信封的响应对象（连不上 503、超时 504），不抛异常：
 * 服务端组件是按 !response.ok 分支的，抛异常会把它们变成白屏。
 */
export async function backendFetch(path: string, init: RequestInit = {}, options: BackendFetchOptions = {}) {
  const token = await sessionToken();
  const headers = new Headers(init.headers);
  const incomingHeaders = await requestHeaders();
  const internalSyncToken = incomingHeaders.get("x-script-sync-internal-token");
  if (!headers.has("x-audit-source")) {
    headers.set("x-audit-source", "web");
  }
  if (internalSyncToken && !headers.has("x-script-sync-internal-token")) {
    headers.set("x-script-sync-internal-token", internalSyncToken);
  }
  for (const name of FORWARDED_HEADERS) {
    const value = incomingHeaders.get(name);
    if (value && !headers.has(name)) headers.set(name, value);
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const budgetMs = options.noTimeout ? null : proxyBudgetMs(incomingHeaders.get(CLIENT_TIMEOUT_HEADER));
  const controller = new AbortController();
  let timedOut = false;
  const callerSignal = init.signal ?? null;
  const abortByCaller = () => controller.abort();
  callerSignal?.addEventListener("abort", abortByCaller, { once: true });
  const timer =
    budgetMs === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, budgetMs);

  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      cache: "no-store"
    });
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    return synthesizedFailure(timedOut ? "timeout" : "unreachable", webTraceId(incomingHeaders.get(REQUEST_ID_HEADER)));
  } finally {
    if (timer !== null) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortByCaller);
  }
}

export async function proxyJson(path: string, init: RequestInit = {}, options: BackendFetchOptions = {}) {
  const response = await backendFetch(path, init, options);
  const text = await response.text();
  const headers = new Headers({
    "content-type": response.headers.get("content-type") ?? "application/json"
  });
  // 追踪号要回到浏览器，否则用户看到的失败提示里没有可报给客服的号。
  const traceId = response.headers.get(REQUEST_ID_HEADER);
  if (traceId) headers.set(REQUEST_ID_HEADER, traceId);
  return new NextResponse(text, {
    status: response.status,
    headers
  });
}
