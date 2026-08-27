import { describe, expect, it } from "vitest";

import { getProjects, saveFile } from "@/lib/api-client";
import { hasErrorCode } from "@/lib/api-error";
import { CLIENT_ERROR_CODES } from "@/lib/error-codes";
import { REQUEST_BUDGETS } from "@/lib/request-budget";

import { installClock } from "../support/clock";
import { installHttpFaults, timeout } from "../support/http-faults";

describe("AT-02 预算到期即中断，且不重发", () => {
  it("读请求在读档到期时中断，并给出等待太久的说明", async () => {
    const clock = installClock();
    const http = installHttpFaults();
    const route = http.route("GET /api/projects").always(timeout());

    const pending = getProjects().catch((error: unknown) => error);
    await clock.advance(REQUEST_BUDGETS.read.browserMs);
    const error = await pending;

    expect(hasErrorCode(error, CLIENT_ERROR_CODES.BACKEND_TIMEOUT)).toBe(true);
    expect(route.calls()[0].aborted).toBe(true);

    await clock.advance(60_000);
    expect(route.callCount()).toBe(1);
  });

  it("阶段保存按覆盖档等待，到期前不中断、到期即中断", async () => {
    const clock = installClock();
    const http = installHttpFaults();
    const route = http.route("PUT /api/projects/*/files/**").always(timeout());

    const pending = saveFile(7, "world_view", "正文").catch((error: unknown) => error);

    // 写档的 45 秒早就过了，阶段保存仍在等——这一条防的是把合法的慢保存判成失败。
    await clock.advance(REQUEST_BUDGETS.write.browserMs + 1000);
    expect(route.calls()[0].aborted).toBe(false);

    await clock.advance(REQUEST_BUDGETS.stageSave.browserMs - REQUEST_BUDGETS.write.browserMs - 1000);
    const error = await pending;

    expect(hasErrorCode(error, CLIENT_ERROR_CODES.BACKEND_TIMEOUT)).toBe(true);
    expect(route.calls()[0].aborted).toBe(true);

    await clock.advance(60_000);
    expect(route.callCount()).toBe(1);
  });
});
