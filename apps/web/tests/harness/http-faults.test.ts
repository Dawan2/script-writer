import { describe, expect, it } from "vitest";

import { installClock } from "../support/clock";
import {
  failure,
  installHttpFaults,
  json,
  malformed,
  networkError,
  timeout
} from "../support/http-faults";

describe("请求故障注入", () => {
  it("按接口区分响应，互不影响", async () => {
    const http = installHttpFaults();
    http.route("GET /api/projects").always(json({ projects: [{ id: 1 }] }));
    http.route("GET /api/auth/me").always(failure(401, { detail: "会话已失效" }));

    const projects = await fetch("/api/projects");
    const me = await fetch("/api/auth/me");

    expect(projects.status).toBe(200);
    expect(await projects.json()).toEqual({ projects: [{ id: 1 }] });
    expect(me.status).toBe(401);
    expect(http.calls().map((call) => call.path)).toEqual(["/api/projects", "/api/auth/me"]);
  });

  it("同一接口按第几次调用给出不同结果", async () => {
    const http = installHttpFaults();
    const route = http
      .route("POST /api/projects")
      .sequence(failure(503, { detail: "服务暂时不可用" }), json({ project: { id: 7 } }));

    const first = await fetch("/api/projects", { method: "POST", body: "{}" });
    const second = await fetch("/api/projects", { method: "POST", body: "{}" });

    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(route.callCount()).toBe(2);
    expect(route.calls().map((call) => call.callIndex)).toEqual([1, 2]);
  });

  it("onCall 只覆盖指定次序，其余调用仍走默认响应", async () => {
    const http = installHttpFaults();
    http.route("GET /api/notifications").always(json({ notifications: [] })).onCall(2, networkError("连接被重置"));

    await expect(fetch("/api/notifications")).resolves.toMatchObject({ status: 200 });
    await expect(fetch("/api/notifications")).rejects.toThrow("连接被重置");
    await expect(fetch("/api/notifications")).resolves.toMatchObject({ status: 200 });
  });

  it("畸形响应让 JSON 解析失败", async () => {
    const http = installHttpFaults();
    http.route("GET /api/credits/me").always(malformed());

    const response = await fetch("/api/credits/me");
    expect(response.ok).toBe(true);
    await expect(response.json()).rejects.toThrow();
  });

  it("延迟由可控时钟推进，不占用真实时间", async () => {
    const clock = installClock();
    const http = installHttpFaults();
    http.route("GET /api/projects").always(json({ projects: [] }, { delayMs: 3_000 }));

    let settled = false;
    const pending = fetch("/api/projects").then((response) => {
      settled = true;
      return response;
    });

    await clock.advance(2_999);
    expect(settled).toBe(false);

    await clock.advance(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("超时响应只在调用方取消时结束", async () => {
    const clock = installClock();
    const http = installHttpFaults();
    http.route("GET /api/projects").always(timeout());

    const controller = new AbortController();
    const pending = fetch("/api/projects", { signal: controller.signal });
    // 断言先挂上，避免拒绝先于断言到达而被报成未捕获的 Promise 异常。
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    setTimeout(() => controller.abort(), 10_000);

    await clock.advance(9_999);
    expect(http.route("GET /api/projects").calls()[0].aborted).toBe(false);

    await clock.advance(1);
    await assertion;
    expect(http.route("GET /api/projects").calls()[0].aborted).toBe(true);
  });

  it("记录请求方法、查询串与请求体", async () => {
    const http = installHttpFaults();
    const route = http.route("PUT /api/projects/*/files/**").always(json({ file: {} }));

    await fetch("/api/projects/12/files/world_view?draft=1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "改过的内容" })
    });

    const [call] = route.calls();
    expect(call.method).toBe("PUT");
    expect(call.path).toBe("/api/projects/12/files/world_view");
    expect(call.search).toBe("?draft=1");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.bodyText ?? "{}")).toEqual({ content: "改过的内容" });
  });

  it("未声明的请求会报错并列出已声明的路由", async () => {
    const http = installHttpFaults({ allowUnmatched: true });
    http.route("GET /api/projects").always(json({ projects: [] }));

    await expect(fetch("/api/unknown")).rejects.toThrow(/测试未声明这个请求[\s\S]*GET \/api\/projects/);
    expect(http.unmatched()).toHaveLength(1);
  });

  it("路由缺少预设响应时给出可操作的报错", async () => {
    const http = installHttpFaults();
    http.route("GET /api/projects").sequence(json({ projects: [] }));

    await fetch("/api/projects");
    await expect(fetch("/api/projects")).rejects.toThrow(/第 2 次调用没有预设响应/);
    expect(http.calls()).toHaveLength(2);
  });
});
