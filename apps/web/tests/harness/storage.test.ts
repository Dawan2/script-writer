import { describe, expect, it } from "vitest";

import { installStorageSandbox } from "../support/storage";

describe("本地存储沙箱", () => {
  it("每个测试拿到干净的存储", () => {
    const sandbox = installStorageSandbox();
    expect(sandbox.local.snapshot()).toEqual({});

    window.localStorage.setItem("draft:12", "草稿内容");
    expect(sandbox.local.snapshot()).toEqual({ "draft:12": "草稿内容" });
    expect(sandbox.local.writeCount()).toBe(1);
  });

  it("上一个测试写入的内容不会串到下一个测试", () => {
    const sandbox = installStorageSandbox();
    expect(sandbox.local.snapshot()).toEqual({});
  });

  it("可预置初始内容，模拟刷新前遗留的草稿", () => {
    const sandbox = installStorageSandbox();
    sandbox.local.seed({ "draft:12": "刷新前的草稿" });

    expect(window.localStorage.getItem("draft:12")).toBe("刷新前的草稿");
  });

  it("可注入写入失败，用于验证保存失败时的提示", () => {
    const sandbox = installStorageSandbox();
    sandbox.local.failWrites("QuotaExceededError");

    expect(() => window.localStorage.setItem("draft:12", "写不进去")).toThrowError(
      expect.objectContaining({ name: "QuotaExceededError" })
    );

    sandbox.local.failWrites(null);
    window.localStorage.setItem("draft:12", "恢复后可写");
    expect(sandbox.local.snapshot()).toEqual({ "draft:12": "恢复后可写" });
  });

  it("会话存储与本地存储互不影响", () => {
    const sandbox = installStorageSandbox();
    window.sessionStorage.setItem("tab", "1");

    expect(sandbox.session.snapshot()).toEqual({ tab: "1" });
    expect(sandbox.local.snapshot()).toEqual({});
  });
});
