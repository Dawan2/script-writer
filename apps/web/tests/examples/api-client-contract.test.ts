import { describe, expect, it } from "vitest";

import { getProjects } from "@/lib/api-client";
import { hasErrorCode, isApiError } from "@/lib/api-error";
import { CLIENT_ERROR_CODES, HTTP_ERROR_CODES } from "@/lib/error-codes";

import { failure, installHttpFaults, json, malformed } from "../support/http-faults";

// 参照用例：故障注入直接作用在真实模块上，路径别名 @/ 在测试里同样可用。
// 这里只固定"请求发到哪里""服务端失败怎么到用户面前"两条既有契约，
// 请求核心自身的超时、退避、追踪号在 tests/request/** 里断言。
describe("示例：给真实接口模块写用例", () => {
  it("搜索关键词会经过转义后进查询串", async () => {
    const http = installHttpFaults();
    const route = http.route("GET /api/projects").always(json({ projects: [] }));

    await getProjects("春节 档期&复盘");

    expect(route.calls()[0].search).toBe(`?query=${encodeURIComponent("春节 档期&复盘")}`);
  });

  it("服务端的中文错误文案原样抛给调用方", async () => {
    const http = installHttpFaults();
    http.route("GET /api/projects").always(
      failure(403, {
        error: {
          code: HTTP_ERROR_CODES.PERMISSION_DENIED,
          category: "permission",
          retryable: false,
          message: "没有该项目的查看权限",
          hint: "让项目负责人给你加上查看权限。",
          traceId: "trace-403"
        }
      })
    );

    const error = await getProjects().catch((caught: unknown) => caught);

    expect(isApiError(error) && error.message).toBe("没有该项目的查看权限");
    expect(hasErrorCode(error, HTTP_ERROR_CODES.PERMISSION_DENIED)).toBe(true);
  });

  it("响应体畸形时给出可报给客服的兜底提示", async () => {
    const http = installHttpFaults();
    http.route("GET /api/projects").always(malformed({ status: 500 }));

    const error = await getProjects().catch((caught: unknown) => caught);

    expect(hasErrorCode(error, CLIENT_ERROR_CODES.RESPONSE_UNREADABLE)).toBe(true);
    expect(isApiError(error) && error.message).toBe("这次请求的返回内容无法读取。");
  });
});
