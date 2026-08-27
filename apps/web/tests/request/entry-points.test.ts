import { describe, expect, it, vi } from "vitest";

import { getProjects, saveFile } from "@/lib/api-client";
import type { ApiError } from "@/lib/api-error";
import { HTTP_ERROR_CODES } from "@/lib/error-codes";
import type { AgentJob } from "@/lib/types";
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/request-budget";
import { onAuthFailure, onConnectionChange, type ConnectionState } from "@/lib/request-core";

import { installClock } from "../support/clock";
import { failure, installHttpFaults, json, networkError } from "../support/http-faults";

describe("接入位：幂等键只透传", () => {
  it("调用方给了幂等键就写进请求头，没给就不出现这个头", async () => {
    const http = installHttpFaults();
    const route = http.route("PUT /api/projects/*/files/**").always(json({ file: {} }));

    await saveFile(7, "world_view", "正文", "hash-1", { idempotencyKey: "save-7-world-view-1" });
    await saveFile(7, "world_view", "正文", "hash-1");

    expect(route.calls()[0].headers[IDEMPOTENCY_KEY_HEADER]).toBe("save-7-world-view-1");
    expect(route.calls()[1].headers[IDEMPOTENCY_KEY_HEADER]).toBeUndefined();
  });
});

describe("接入位：会话失效只广播", () => {
  it("失败属于登录态问题时通知处理器，其余失败不通知", async () => {
    const http = installHttpFaults();
    http.route("GET /api/projects").sequence(
      failure(401, {
        error: {
          code: HTTP_ERROR_CODES.SESSION_EXPIRED,
          category: "auth",
          retryable: false,
          message: "登录状态已过期。",
          hint: "重新登录后可以回到刚才的位置。",
          traceId: "trace-401"
        }
      }),
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

    const seen: string[] = [];
    const stop = onAuthFailure((error: ApiError) => seen.push(error.code));

    await getProjects().catch(() => undefined);
    await getProjects().catch(() => undefined);
    stop();

    expect(seen).toEqual([HTTP_ERROR_CODES.SESSION_EXPIRED]);
  });
});

describe("接入位：连接状态只广播", () => {
  it("连不上时广播一次，恢复后再广播一次", async () => {
    const clock = installClock();
    const http = installHttpFaults();
    http.route("GET /api/projects").sequence(
      networkError(),
      networkError(),
      networkError(),
      json({ projects: [] })
    );

    const states: ConnectionState[] = [];
    const stop = onConnectionChange((state) => states.push(state));

    const failing = getProjects().catch(() => undefined);
    await clock.advance(3000);
    await failing;
    await getProjects();
    stop();

    expect(states).toEqual(["unreachable", "reachable"]);
  });
});

describe("AT-14 Agent 失败的类型字段就位", () => {
  it("AgentJob 能读到错误码、错误分类与是否可重试", () => {
    const job: AgentJob = {
      id: 1,
      project_id: 2,
      user_id: 3,
      stage: "world_view",
      status: "failed",
      claude_session_id: "session-1",
      dry_run: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:01:00Z",
      error_code: "QUALITY_GATE",
      error_category: "quality",
      error_retryable: true
    };

    expect(job.error_code).toBe("QUALITY_GATE");
    expect(job.error_category).toBe("quality");
    expect(job.error_retryable).toBe(true);
  });
});

describe("取消与超时不同名", () => {
  it("调用方取消时不抛带错误码的失败，也不广播连接状态", async () => {
    const http = installHttpFaults();
    http.route("GET /api/projects").always(json({ projects: [] }));
    const listener = vi.fn();
    const stop = onConnectionChange(listener);
    const controller = new AbortController();
    controller.abort();

    const error = await getProjects(undefined, { signal: controller.signal }).catch(
      (caught: unknown) => caught
    );
    stop();

    expect((error as Error).name).toBe("RequestCancelled");
    expect(listener).not.toHaveBeenCalled();
  });
});
