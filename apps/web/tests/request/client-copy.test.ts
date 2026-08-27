import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CLIENT_ERROR_TEXT } from "@/lib/api-error";
import { CLIENT_ERROR_CODES } from "@/lib/error-codes";

// vitest 的工作目录是 apps/web；注册表在后端，是这三条文案的唯一事实源。
const registry = JSON.parse(
  readFileSync(resolve(process.cwd(), "../api/app/core/error_codes.json"), "utf8")
) as { client_codes: Record<string, { message: string; hint: string }> };

describe("AT-11 客户端文案不漂移", () => {
  it("三条客户端错误码的文案与注册表逐字一致", () => {
    const codes = Object.values(CLIENT_ERROR_CODES);
    expect(codes).toHaveLength(3);

    for (const code of codes) {
      expect(registry.client_codes[code], `注册表缺 ${code}`).toBeTruthy();
      expect(CLIENT_ERROR_TEXT[code].message).toBe(registry.client_codes[code].message);
      expect(CLIENT_ERROR_TEXT[code].hint).toBe(registry.client_codes[code].hint);
    }
  });

  it("注册表里的客户端错误码没有一条缺镜像", () => {
    expect(Object.keys(CLIENT_ERROR_TEXT).sort()).toEqual(Object.keys(registry.client_codes).sort());
  });
});
