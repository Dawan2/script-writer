/**
 * 请求预算表与代理层换算。纯数据与纯函数，浏览器与代理层共用同一份，避免两侧各写一张表。
 *
 * 三条不变量（用例 tests/request/budget.test.ts 逐行断言）：
 * 1. 浏览器预算 > 代理层预算：代理层先到期，用户拿到的才是带追踪号的失败说明，而不是浏览器无声掐断；
 * 2. 代理层预算 > 后端子进程上限：否则一次合法的慢保存会被判成失败；
 * 3. 进展流不设总超时。
 */

/** 浏览器生成、全链沿用的追踪号请求头。 */
export const REQUEST_ID_HEADER = "x-request-id";
/** 幂等键请求头，浏览器只透传，键由调用方生成。 */
export const IDEMPOTENCY_KEY_HEADER = "x-idempotency-key";
/** 浏览器把本次预算声明给代理层的请求头。 */
export const CLIENT_TIMEOUT_HEADER = "x-client-timeout-ms";

/** 代理层预算 = 浏览器预算 − 这个余量。 */
export const PROXY_BUDGET_MARGIN_MS = 5000;
/** 代理层预算的下限。 */
export const PROXY_BUDGET_FLOOR_MS = 5000;

/** 没拿到后端响应时，合成信封的追踪号前缀；查后端日志时要去掉它。 */
export const WEB_TRACE_PREFIX = "web-";

export type BudgetTier = "read" | "write" | "upload";

/** 后端留了分钟级子进程预算的接口，按接口登记覆盖档。 */
export type BudgetOverride =
  | "stageSave"
  | "stageApprove"
  | "projectReinitialize"
  | "distributionBriefSave"
  | "outlineTitleSync"
  | "projectReopen"
  | "distributionBriefRead"
  | "projectMemoryRead";

export type BudgetKey = BudgetTier | BudgetOverride | "stream";

interface BudgetRow<T extends number | null> {
  /** 这一档对应的操作，用户视角的说法，用例与证据里按它对齐。 */
  label: string;
  browserMs: T;
  proxyMs: T;
  /** 后端在这个接口上实测的子进程上限；没有子进程的档为 null。 */
  backendLimitMs: number | null;
}

export type RequestBudget = BudgetRow<number | null>;

export const BUDGET_TIERS: readonly BudgetTier[] = ["read", "write", "upload"];

export const BUDGET_OVERRIDES: readonly BudgetOverride[] = [
  "stageSave",
  "stageApprove",
  "projectReinitialize",
  "distributionBriefSave",
  "outlineTitleSync",
  "projectReopen",
  "distributionBriefRead",
  "projectMemoryRead"
];

export const REQUEST_BUDGETS: Record<BudgetTier | BudgetOverride, BudgetRow<number>> &
  Record<"stream", BudgetRow<null>> = {
  read: { label: "读取（默认）", browserMs: 12_000, proxyMs: 7_000, backendLimitMs: null },
  write: { label: "写入（默认）", browserMs: 45_000, proxyMs: 40_000, backendLimitMs: null },
  upload: { label: "上传（默认）", browserMs: 240_000, proxyMs: 235_000, backendLimitMs: 180_000 },
  stageSave: { label: "保存阶段文档", browserMs: 330_000, proxyMs: 325_000, backendLimitMs: 300_000 },
  stageApprove: { label: "确认阶段通过", browserMs: 330_000, proxyMs: 325_000, backendLimitMs: 300_000 },
  projectReinitialize: { label: "重新初始化项目", browserMs: 120_000, proxyMs: 115_000, backendLimitMs: 90_000 },
  distributionBriefSave: { label: "保存发行简报", browserMs: 90_000, proxyMs: 85_000, backendLimitMs: 60_000 },
  outlineTitleSync: { label: "同步剧本名", browserMs: 90_000, proxyMs: 85_000, backendLimitMs: 60_000 },
  projectReopen: { label: "重新开启项目", browserMs: 90_000, proxyMs: 85_000, backendLimitMs: 60_000 },
  distributionBriefRead: { label: "读取发行简报", browserMs: 45_000, proxyMs: 40_000, backendLimitMs: 30_000 },
  projectMemoryRead: { label: "读取项目记忆状态", browserMs: 90_000, proxyMs: 85_000, backendLimitMs: 60_000 },
  stream: { label: "进展流", browserMs: null, proxyMs: null, backendLimitMs: null }
};

export function budgetOf(key: BudgetKey): RequestBudget {
  return REQUEST_BUDGETS[key];
}

/**
 * 代理层按请求头换算本次预算。
 * 头缺失、非数字、≤ 0 都按读档：服务端组件不带头调用时走这一支。
 * 「不设超时」只能由服务端代码显式传参，不能由请求头声明。
 */
export function proxyBudgetMs(header: string | null | undefined): number {
  const declared = header === null || header === undefined || header.trim() === "" ? NaN : Number(header);
  if (!Number.isFinite(declared) || declared <= 0) return REQUEST_BUDGETS.read.proxyMs;
  return Math.max(declared - PROXY_BUDGET_MARGIN_MS, PROXY_BUDGET_FLOOR_MS);
}

export function newTraceId(): string {
  const random = globalThis.crypto;
  if (random && typeof random.randomUUID === "function") return random.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 合成失败信封用的追踪号：沿用原号并加前缀，没有原号就新生成一个。 */
export function webTraceId(original?: string | null): string {
  const trimmed = typeof original === "string" ? original.trim() : "";
  return `${WEB_TRACE_PREFIX}${trimmed || newTraceId()}`;
}
