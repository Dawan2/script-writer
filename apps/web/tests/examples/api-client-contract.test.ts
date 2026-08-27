import { describe, expect, it } from "vitest";

import { getProjects } from "@/lib/api-client";

import { failure, installHttpFaults, json, malformed } from "../support/http-faults";

// 参照用例：故障注入直接作用在真实模块上，路径别名 @/ 在测试里同样可用。
// 这里只固定"请求发到哪里""服务端文案怎么到用户面前"两条既有契约，
// 请求核心自身的超时、重试、错误分级由 C1-W1-03 落地并补自己的用例。
describe("示例：给真实接口模块写用例", () => {
  it("搜索关键词会经过转义后进查询串", async () => {
    const http = installHttpFaults();
    const route = http.route("GET /api/projects").always(json({ projects: [] }));

    await getProjects("春节 档期&复盘");

    expect(route.calls()[0].search).toBe(`?query=${encodeURIComponent("春节 档期&复盘")}`);
  });

  it("服务端的中文错误文案原样抛给调用方", async () => {
    const http = installHttpFaults();
    http.route("GET /api/projects").always(failure(403, { detail: "没有该项目的查看权限" }));

    await expect(getProjects()).rejects.toThrow("没有该项目的查看权限");
  });

  it("响应体畸形时给出带状态码的兜底文案", async () => {
    const http = installHttpFaults();
    http.route("GET /api/projects").always(malformed({ status: 500 }));

    await expect(getProjects()).rejects.toThrow("请求失败（500）");
  });
});
