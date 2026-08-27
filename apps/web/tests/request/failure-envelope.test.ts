import { describe, expect, it } from "vitest";

import { getProjects, saveFile } from "@/lib/api-client";
import { hasErrorCode, isApiError } from "@/lib/api-error";
import { CLIENT_ERROR_CODES, HTTP_ERROR_CODES } from "@/lib/error-codes";
import { REQUEST_ID_HEADER, WEB_TRACE_PREFIX } from "@/lib/request-budget";

import { installClock } from "../support/clock";
import { failure, installHttpFaults, json, networkError } from "../support/http-faults";

describe("AT-09 追踪号浏览器生成、全链沿用", () => {
  it("每个请求都带上浏览器生成的追踪号", async () => {
    const http = installHttpFaults();
    const route = http.route("GET /api/projects").always(json({ projects: [] }));

    await getProjects();

    const sent = route.calls()[0].headers[REQUEST_ID_HEADER];
    expect(sent).toBeTruthy();
    expect(sent.startsWith(WEB_TRACE_PREFIX)).toBe(false);
  });

  it("失败时的追踪号取代理层复制回来的那一个", async () => {
    const http = installHttpFaults();
    http.route("PUT /api/projects/*/files/**").always(
      failure(
        409,
        {
          error: {
            code: HTTP_ERROR_CODES.STATE_CONFLICT,
            category: "conflict",
            retryable: false,
            message: "这份文档已被他人修改。",
            hint: "刷新后再保存。",
            traceId: "envelope-trace"
          }
        },
        { headers: { [REQUEST_ID_HEADER]: "backend-trace-1" } }
      )
    );

    const error = await saveFile(7, "world_view", "正文").catch((caught: unknown) => caught);

    expect(isApiError(error) && error.traceId).toBe("backend-trace-1");
  });

  it("代理层没复制追踪号时沿用浏览器这次生成的号", async () => {
    const http = installHttpFaults();
    const route = http.route("GET /api/projects").always(
      failure(403, {
        error: {
          code: HTTP_ERROR_CODES.PERMISSION_DENIED,
          category: "permission",
          retryable: false,
          message: "没有该项目的查看权限",
          hint: "让项目负责人给你加上查看权限。"
        }
      })
    );

    const error = await getProjects().catch((caught: unknown) => caught);

    expect(isApiError(error) && error.traceId).toBe(route.calls()[0].headers[REQUEST_ID_HEADER]);
  });
});

describe("AT-10 后端连不上有专门表述", () => {
  it("一次响应都没拿到时给出连不上的说明，追踪号带 web- 前缀", async () => {
    const clock = installClock();
    const http = installHttpFaults();
    http.route("PUT /api/projects/*/files/**").always(networkError());

    const pending = saveFile(7, "world_view", "正文").catch((caught: unknown) => caught);
    await clock.advance(1000);
    const error = await pending;

    expect(hasErrorCode(error, CLIENT_ERROR_CODES.BACKEND_UNREACHABLE)).toBe(true);
    expect(isApiError(error) && error.category).toBe("runtime");
    expect(isApiError(error) && error.retryable).toBe(true);
    expect(isApiError(error) && error.traceId.startsWith(WEB_TRACE_PREFIX)).toBe(true);
    expect(isApiError(error) && error.message).toBe("服务暂时连不上，不是这次操作有问题。");
  });
});

describe("AT-05 失败对象带类型，可按错误码分支", () => {
  it("按错误码分支：命中与不命中各一条", async () => {
    const http = installHttpFaults();
    http.route("PUT /api/projects/*/files/**").always(
      failure(422, {
        error: {
          code: HTTP_ERROR_CODES.STAGE_CHECK_FAILED,
          category: "quality",
          retryable: false,
          message: "这一稿还有几处需要先补齐。",
          hint: "按下面列出的项目逐条补齐后再保存。",
          traceId: "trace-422",
          details: { issues: ["缺少人物小传", "第 3 集时长不足"] }
        }
      })
    );

    const error = await saveFile(7, "novel_analysis", "正文").catch((caught: unknown) => caught);

    expect(hasErrorCode(error, HTTP_ERROR_CODES.STAGE_CHECK_FAILED)).toBe(true);
    expect(hasErrorCode(error, HTTP_ERROR_CODES.STATE_CONFLICT)).toBe(false);
    expect(isApiError(error) && error.details?.issues).toEqual(["缺少人物小传", "第 3 集时长不足"]);
  });
});
