import { afterEach } from "vitest";

import { resetHarness } from "./support/lifecycle";

// 每个测试结束后还原全部注入：时钟、fetch、连接状态、页面可见性、本地存储。
// 注入工具在还原时会把"未声明的请求"这类问题抛出来，测试因此不会假通过。
afterEach(() => {
  resetHarness();
});
