# 前端测试基座使用说明

前端修复的验收要能自动重跑，否则每次改动都只剩一次性的人工结论。这里是给各工作项写前端用例用的基座。

## 怎么跑

| 命令 | 作用 |
| --- | --- |
| `npm run test:web`（仓库根） | 跑全部前端用例，也被根 `npm test` 串接 |
| `npm run test:web:watch` | 改代码即时重跑 |
| `npm run check:web` | 类型检查 + 网络出口静态检查 |
| `npm run test:web:e2e` | 真实浏览器的端到端用例，需先 `cd apps/web && npm run test:e2e:install` |

`npm test` 会把 Agent、服务端、排障工具、前端四个套件全部跑完再汇总，任一套件失败仍以非零退出。

## 目录

| 位置 | 内容 |
| --- | --- |
| `tests/support/` | 注入工具：可控时钟、请求故障注入、连接状态与页面可见性、本地存储沙箱 |
| `tests/harness/` | 基座自检，改动 `support/` 后必须保持通过 |
| `tests/examples/` | 参照用例，新写前端用例时先看这里 |
| `tests/e2e/` | 端到端最小骨架 |
| `tests/fixtures/` | 夹具，含静态检查的反例 |

每个测试结束后，`tests/setup.ts` 会自动还原全部注入，不需要手写清理。

## 请求故障注入

按接口声明响应，并可按第几次调用给出不同结果。

```ts
import { failure, installHttpFaults, json, malformed, networkError, timeout } from "../support/http-faults";

const http = installHttpFaults();

// 所有调用同一响应
http.route("GET /api/projects").always(json({ projects: [] }));

// 第 1 次超时、第 2 次 503、第 3 次成功
http.route("POST /api/projects").sequence(timeout(), failure(503, { detail: "服务暂时不可用" }), json({ project: { id: 1 } }));

// 只让第 2 次断网，其余走默认响应
http.route("GET /api/notifications").always(json({ notifications: [] })).onCall(2, networkError());

// 响应体不是合法 JSON
http.route("GET /api/credits/me").always(malformed());

// 延迟 3 秒，由可控时钟推进
http.route("GET /api/auth/me").always(json({ user: null }, { delayMs: 3_000 }));
```

- 路由写成「方法 路径」。路径里 `*` 匹配一个路径段，`**` 匹配任意层级；带 `?` 时还会校验查询参数。
- `http.route(...).calls()` 拿到请求记录：方法、路径、查询串、请求头、请求体、是否被取消。
- 未声明的请求会让 `fetch` 报错并列出已声明的路由，测试结束时还会再失败一次——代码把异常吞掉时不会假通过。确实要放行时传 `installHttpFaults({ allowUnmatched: true })`。
- `timeout()` 的响应永不返回，只有调用方自己 `AbortSignal` 取消才会结束，用于验证超时是不是真由前端兜住。

## 可控时钟

超时、退避、轮询间隔的断言不必真等。

```ts
import { installClock } from "../support/clock";

const clock = installClock({ now: "2026-03-05T10:00:00Z" });
await clock.advance(5_000);        // 推进 5 秒并结算到期回调
await clock.advanceToNextTimer();  // 推进到下一个定时器，不必知道具体间隔
clock.pendingTimers();             // 还有几个定时器没触发
```

故障注入的响应延迟也走全局定时器，装上时钟后同样由 `advance` 驱动。注意：响应延迟为 0 时立即返回，不排定时器。

## 连接状态与页面可见性

```ts
import { installBrowserState } from "../support/browser-state";

const browser = installBrowserState();
browser.goOffline();            // navigator.onLine 转 false 并派发 offline
browser.hide();                 // 切到后台标签页并派发 visibilitychange
browser.triggerBeforeUnload();  // 触发关闭/刷新前确认，返回值可断言是否被拦截
```

## 本地存储沙箱

```ts
import { installStorageSandbox } from "../support/storage";

const sandbox = installStorageSandbox();
sandbox.local.seed({ "draft:12": "刷新前的草稿" });
sandbox.local.failWrites("QuotaExceededError");  // 模拟配额耗尽
sandbox.local.snapshot();                        // 读回当前内容
```

## 组件渲染与用户操作

用 `@testing-library/react` 渲染、`@testing-library/user-event` 模拟操作，写法见 `tests/harness/render.test.tsx`。路径别名 `@/` 在测试里同样可用。

## 网络出口静态检查

前端请求必须走已登记的网络出口，才能统一超时、重试、错误解析与离线门控。检查脚本是 `scripts/check-no-bare-fetch.mjs`，已接入 `npm run check:web`。

新增网络出口须在 `scripts/allowed-network-egress.json` 登记并写明理由。反例与拦截输出见 `tests/harness/no-bare-fetch.test.ts` 与 `tests/fixtures/bare-fetch-violation.fixture.tsx`。

## 端到端用例

`tests/e2e/` 用 Playwright 跑真实浏览器，覆盖 jsdom 到不了的地方：关标签页确认、跨页跳转与后退、真实焦点与滚动、SSE 长连接。它需要浏览器内核与本地服务，因此不进 `npm test` 的默认链条。

运行会用 `.next-e2e` 作为构建目录，Next.js 会顺手改写 `next-env.d.ts` 里的引用，这一处改动不要提交；下次 `npm run dev` 会改回来。跑端到端用例时请先停掉本地开发服务。
