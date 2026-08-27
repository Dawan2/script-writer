import { describe, expect, it } from "vitest";

import { installBrowserState } from "../support/browser-state";

describe("连接状态与页面可见性注入", () => {
  it("断网与恢复都会派发事件", () => {
    const browser = installBrowserState();
    const seen: string[] = [];
    window.addEventListener("offline", () => seen.push("offline"));
    window.addEventListener("online", () => seen.push("online"));

    expect(browser.isOnline()).toBe(true);
    browser.goOffline();
    expect(navigator.onLine).toBe(false);
    browser.goOnline();
    expect(navigator.onLine).toBe(true);
    expect(seen).toEqual(["offline", "online"]);
  });

  it("切后台与回前台都会派发 visibilitychange", () => {
    const browser = installBrowserState();
    const seen: string[] = [];
    document.addEventListener("visibilitychange", () => seen.push(document.visibilityState));

    browser.hide();
    expect(document.hidden).toBe(true);
    browser.show();
    expect(document.hidden).toBe(false);
    expect(seen).toEqual(["hidden", "visible"]);
  });

  it("可从初始离线状态起算", () => {
    installBrowserState({ online: false, visibility: "hidden" });
    expect(navigator.onLine).toBe(false);
    expect(document.visibilityState).toBe("hidden");
  });

  it("关闭前确认的时机可被触发，并能观察到是否被拦截", () => {
    const browser = installBrowserState();
    const withoutGuard = browser.triggerBeforeUnload();
    expect(withoutGuard.defaultPrevented).toBe(false);

    window.addEventListener("beforeunload", (event) => event.preventDefault());
    const withGuard = browser.triggerBeforeUnload();
    expect(withGuard.defaultPrevented).toBe(true);
  });

  it("还原后不再影响真实状态", () => {
    const browser = installBrowserState({ online: false });
    expect(navigator.onLine).toBe(false);
    browser.uninstall();
    expect(navigator.onLine).toBe(true);
  });
});
