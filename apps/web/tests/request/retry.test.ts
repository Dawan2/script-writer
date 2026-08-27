import { describe, expect, it } from "vitest";

import { batchTaskAction, getProjects } from "@/lib/api-client";
import { isApiError } from "@/lib/api-error";

import { installClock } from "../support/clock";
import { failure, installHttpFaults, networkError } from "../support/http-faults";

function gatewayEnvelope(status: number) {
  return failure(status, {
    error: {
      code: "SERVICE_UNAVAILABLE",
      category: "runtime",
      retryable: true,
      message: "服务正在恢复，请稍后再试。",
      hint: "稍等一会儿重试。",
      traceId: `trace-${status}`
    }
  });
}

describe("AT-06 只读退避两次，写操作零重发", () => {
  it("读请求连续遇到 502：第 2、3 次调用发生在 +500 ms 与 +1500 ms，没有第 4 次", async () => {
    const clock = installClock();
    const http = installHttpFaults();
    const route = http.route("GET /api/projects").always(gatewayEnvelope(502));

    const pending = getProjects().catch((error: unknown) => error);
    await clock.flush();
    expect(route.callCount()).toBe(1);

    await clock.advance(499);
    expect(route.callCount()).toBe(1);
    await clock.advance(1);
    expect(route.callCount()).toBe(2);

    await clock.advance(1499);
    expect(route.callCount()).toBe(2);
    await clock.advance(1);
    expect(route.callCount()).toBe(3);

    await clock.advance(60_000);
    expect(route.callCount()).toBe(3);

    const error = await pending;
    expect(isApiError(error) && error.retryable).toBe(true);
  });

  it("读请求一次响应都没拿到时同样只退避两次", async () => {
    const clock = installClock();
    const http = installHttpFaults();
    const route = http.route("GET /api/projects").always(networkError());

    const pending = getProjects().catch((error: unknown) => error);
    await clock.advance(3000);
    await pending;

    expect(route.callCount()).toBe(3);
  });

  it("读请求拿到 429 或 4xx 时不重试", async () => {
    const clock = installClock();
    const http = installHttpFaults();
    const limited = http.route("GET /api/projects").always(gatewayEnvelope(429));

    const pending = getProjects().catch((error: unknown) => error);
    await clock.advance(3000);
    await pending;

    expect(limited.callCount()).toBe(1);
  });

  it("写操作在四种传输层失败下都只发一次，带幂等键也不重发", async () => {
    for (const fault of [networkError(), gatewayEnvelope(502), gatewayEnvelope(503), gatewayEnvelope(504)]) {
      for (const idempotencyKey of [undefined, "key-42"]) {
        const clock = installClock();
        const http = installHttpFaults();
        const route = http.route("POST /api/batch-tasks/bulk").always(fault);

        const pending = batchTaskAction("pause", [1, 2], { idempotencyKey }).catch(
          (error: unknown) => error
        );
        await clock.advance(60_000);
        await pending;

        expect(route.callCount()).toBe(1);
        clock.uninstall();
        http.uninstall();
      }
    }
  });
});
