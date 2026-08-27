import { describe, expect, it, vi } from "vitest";

import { CLIENT_ERROR_CODES } from "@/lib/error-codes";
import {
  CLIENT_TIMEOUT_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  REQUEST_BUDGETS,
  WEB_TRACE_PREFIX,
  proxyBudgetMs
} from "@/lib/request-budget";

import { installClock } from "../support/clock";
import { installHttpFaults, json, networkError, timeout } from "../support/http-faults";

const state = vi.hoisted(() => ({ incoming: new Headers() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "session-token" }) }),
  headers: async () => state.incoming
}));

const { backendFetch, proxyJson } = await import("@/lib/server/backend");

function browserRequest(extra: Record<string, string> = {}) {
  state.incoming = new Headers({
    [REQUEST_ID_HEADER]: "browser-trace-1",
    [IDEMPOTENCY_KEY_HEADER]: "save-7-1",
    [CLIENT_TIMEOUT_HEADER]: String(REQUEST_BUDGETS.stageSave.browserMs),
    ...extra
  });
}

describe("AT-09 代理层透传并复制追踪号", () => {
  it("浏览器加的三个头都带到后端", async () => {
    browserRequest();
    const http = installHttpFaults();
    const route = http.route("PUT /projects/7/files/world_view").always(json({ file: {} }));

    await backendFetch("/projects/7/files/world_view", { method: "PUT" });

    const sent = route.calls()[0].headers;
    expect(sent[REQUEST_ID_HEADER]).toBe("browser-trace-1");
    expect(sent[IDEMPOTENCY_KEY_HEADER]).toBe("save-7-1");
    expect(sent[CLIENT_TIMEOUT_HEADER]).toBe(String(REQUEST_BUDGETS.stageSave.browserMs));
  });

  it("后端响应头里的追踪号被复制回浏览器", async () => {
    browserRequest();
    const http = installHttpFaults();
    http
      .route("GET /projects")
      .always(json({ projects: [] }, { headers: { [REQUEST_ID_HEADER]: "backend-trace-9" } }));

    const response = await proxyJson("/projects");

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("backend-trace-9");
  });
});

describe("AT-10 代理层合成的失败信封", () => {
  it("后端连不上：503 加连不上的信封，追踪号带 web- 前缀", async () => {
    browserRequest();
    const http = installHttpFaults();
    http.route("GET /projects").always(networkError());

    const response = await proxyJson("/projects");
    const payload = (await response.json()) as { error: Record<string, unknown> };

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe(CLIENT_ERROR_CODES.BACKEND_UNREACHABLE);
    expect(payload.error.category).toBe("runtime");
    expect(payload.error.retryable).toBe(true);
    expect(payload.error.traceId).toBe(`${WEB_TRACE_PREFIX}browser-trace-1`);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(`${WEB_TRACE_PREFIX}browser-trace-1`);
  });

  it("代理层预算到期：504 加等待太久的信封，且比浏览器预算先到期", async () => {
    browserRequest({ [CLIENT_TIMEOUT_HEADER]: String(REQUEST_BUDGETS.read.browserMs) });
    const clock = installClock();
    const http = installHttpFaults();
    const route = http.route("GET /projects").always(timeout());

    const pending = proxyJson("/projects");
    await clock.advance(proxyBudgetMs(String(REQUEST_BUDGETS.read.browserMs)) - 1);
    expect(route.calls()[0].aborted).toBe(false);

    await clock.advance(1);
    const response = await pending;
    const payload = (await response.json()) as { error: Record<string, unknown> };

    expect(response.status).toBe(504);
    expect(payload.error.code).toBe(CLIENT_ERROR_CODES.BACKEND_TIMEOUT);
    expect(route.calls()[0].aborted).toBe(true);
  });
});

describe("AT-13 进展流在代理层也不设总超时", () => {
  it("声明不设超时的请求不排任何预算定时器", async () => {
    browserRequest();
    const clock = installClock();
    const http = installHttpFaults();
    http.route("GET /agent/jobs/1/stream").always(timeout());
    const controller = new AbortController();

    const pending = backendFetch("/agent/jobs/1/stream", { signal: controller.signal }, { noTimeout: true });
    await clock.flush();

    expect(clock.pendingTimers()).toBe(0);

    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
