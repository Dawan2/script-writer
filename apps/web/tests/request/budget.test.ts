import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUDGET_OVERRIDES,
  BUDGET_TIERS,
  PROXY_BUDGET_FLOOR_MS,
  REQUEST_BUDGETS,
  proxyBudgetMs,
  type BudgetOverride,
  type BudgetTier
} from "@/lib/request-budget";

// vitest 的工作目录是 apps/web。
const appRoot = process.cwd();
const apiClientSource = readFileSync(resolve(appRoot, "src/lib/api-client.ts"), "utf8");
const streamRouteSource = readFileSync(
  resolve(appRoot, "src/app/api/agent/jobs/[jobId]/stream/route.ts"),
  "utf8"
);

const finiteKeys: Array<BudgetTier | BudgetOverride> = [...BUDGET_TIERS, ...BUDGET_OVERRIDES];

describe("AT-01 预算表的不变量逐行成立", () => {
  it("每一档的浏览器预算都大于代理层预算，共 11 行有限值", () => {
    const rows = finiteKeys.map((key) => ({ key, ...REQUEST_BUDGETS[key] }));

    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row.browserMs, `${row.label} 的浏览器预算`).toBeGreaterThan(row.proxyMs);
    }
  });

  it("有后端子进程上限的行，代理层预算都大于该上限", () => {
    const rows = finiteKeys
      .map((key) => ({ key, ...REQUEST_BUDGETS[key] }))
      .filter((row) => row.backendLimitMs !== null);

    // 8 个覆盖档各有一条后端登记值，上传默认档另有一条。
    expect(rows.filter((row) => BUDGET_OVERRIDES.includes(row.key as never))).toHaveLength(8);
    for (const row of rows) {
      expect(row.proxyMs, `${row.label} 的代理层预算`).toBeGreaterThan(row.backendLimitMs as number);
    }
  });

  it("每个覆盖档在 api-client.ts 里有且只有一个声明点", () => {
    for (const key of BUDGET_OVERRIDES) {
      const declarations = apiClientSource.split(`budget: "${key}"`).length - 1;
      expect(declarations, `${REQUEST_BUDGETS[key].label} 的声明点数量`).toBe(1);
    }
  });
});

describe("AT-04 代理层预算换算", () => {
  it("按浏览器声明的预算减 5 秒", () => {
    expect(proxyBudgetMs("12000")).toBe(7000);
    expect(proxyBudgetMs("330000")).toBe(325000);
  });

  it("头缺失、非数字、零或负数都按读档", () => {
    const readProxyMs = REQUEST_BUDGETS.read.proxyMs;
    expect(proxyBudgetMs(null)).toBe(readProxyMs);
    expect(proxyBudgetMs(undefined)).toBe(readProxyMs);
    expect(proxyBudgetMs("")).toBe(readProxyMs);
    expect(proxyBudgetMs("很快")).toBe(readProxyMs);
    expect(proxyBudgetMs("0")).toBe(readProxyMs);
    expect(proxyBudgetMs("-1")).toBe(readProxyMs);
  });

  it("声明值极小时不低于下限", () => {
    expect(proxyBudgetMs("1")).toBe(PROXY_BUDGET_FLOOR_MS);
  });
});

describe("AT-13 进展流不设总超时", () => {
  it("预算表没给进展流任何有限值", () => {
    expect(REQUEST_BUDGETS.stream.browserMs).toBeNull();
    expect(REQUEST_BUDGETS.stream.proxyMs).toBeNull();
  });

  it("进展流路由显式声明不设超时", () => {
    expect(streamRouteSource).toContain("noTimeout: true");
  });
});
