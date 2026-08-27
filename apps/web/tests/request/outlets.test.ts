import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error 检查脚本是 .mjs，无类型声明；此处只用它找裸 fetch 的纯函数。
import { findBareFetch } from "../../scripts/check-no-bare-fetch.mjs";

// vitest 的工作目录是 apps/web。
const appRoot = process.cwd();
const srcRoot = resolve(appRoot, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
  });
}

describe("AT-08 裸 fetch 归零，出口清单同步收紧", () => {
  it("两个业务接口模块里一次 fetch 都不剩", () => {
    for (const file of ["src/lib/api-client.ts", "src/lib/admin-api.ts"]) {
      const source = readFileSync(resolve(appRoot, file), "utf8");
      expect(findBareFetch(source), `${file} 仍有裸 fetch`).toEqual([]);
    }
  });

  it("出口清单只留两个文件，且不含这两个接口模块", () => {
    const config = JSON.parse(readFileSync(resolve(appRoot, "scripts/allowed-network-egress.json"), "utf8")) as {
      文件: Array<{ 路径: string }>;
    };
    const paths = config["文件"].map((item) => item["路径"]);

    expect(paths).toHaveLength(2);
    expect(paths).toContain("src/lib/request-core.ts");
    expect(paths).toContain("src/lib/server/backend.ts");
    expect(paths).not.toContain("src/lib/api-client.ts");
    expect(paths).not.toContain("src/lib/admin-api.ts");
  });
});

describe("AT-05 从错误文案里反解结构的写法归零", () => {
  it("前端不再对着错误文案做字符串匹配", () => {
    const offenders = sourceFiles(srcRoot).filter((file) =>
      readFileSync(file, "utf8").includes('indexOf("{")')
    );

    expect(offenders.map((file) => relative(appRoot, file))).toEqual([]);
  });
});
