import { describe, expect, it } from "vitest";

import { installClock } from "../support/clock";
import { failure, installHttpFaults, json, timeout } from "../support/http-faults";
import { requestWithRetry } from "./reference-request";

// 参照用例：同时使用故障注入与可控时钟。
// 其他工作项写"超时后重试""退避间隔""重试次数上限"的验收时可以直接照抄这套写法。
describe("示例：超时与退避的验收怎么写", () => {
  it("首次超时、第二次 503、第三次成功，全程不占真实时间", async () => {
    const realStart = Date.now();
    const clock = installClock({ now: "2026-03-05T10:00:00Z" });
    const http = installHttpFaults();
    const route = http
      .route("GET /api/projects")
      .sequence(timeout(), failure(503, { detail: "服务暂时不可用" }), json({ projects: [{ id: 1 }] }));

    const pending = requestWithRetry("/api/projects", { timeoutMs: 5_000, backoffMs: 1_000, maxRetries: 2 });

    // 第 1 次：等到超时阈值才被取消
    await clock.advance(4_999);
    expect(route.callCount()).toBe(1);
    await clock.advance(1);
    expect(route.calls()[0].aborted).toBe(true);

    // 退避 1 秒后发起第 2 次
    await clock.advance(999);
    expect(route.callCount()).toBe(1);
    await clock.advance(1);
    expect(route.callCount()).toBe(2);

    // 退避翻倍到 2 秒后发起第 3 次
    await clock.advance(2_000);
    const { response, attempts } = await pending;
    clock.uninstall();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projects: [{ id: 1 }] });
    expect(attempts.map((item) => item.outcome)).toEqual(["timeout", "serverError", "ok"]);
    // 三次请求的发起时刻：0s、6s（5s 超时 + 1s 退避）、8s（+2s 退避）
    const base = Date.parse("2026-03-05T10:00:00Z");
    expect(attempts.map((item) => item.startedAt - base)).toEqual([0, 6_000, 8_000]);
    expect(Date.now() - realStart).toBeLessThan(8_000);
  });

  it("重试次数用尽后抛错，不会无限重试", async () => {
    const clock = installClock();
    const http = installHttpFaults();
    const route = http.route("GET /api/projects").always(failure(503, { detail: "服务暂时不可用" }));

    const pending = requestWithRetry("/api/projects", { timeoutMs: 5_000, backoffMs: 1_000, maxRetries: 2 });
    const assertion = expect(pending).rejects.toThrow("已重试 2 次");

    await clock.advance(10_000);
    await assertion;
    expect(route.callCount()).toBe(3);
  });
});
