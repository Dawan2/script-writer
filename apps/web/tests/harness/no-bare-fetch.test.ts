import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error 检查脚本是 .mjs，无类型声明；此处只用它的两个纯函数。
import { findBareFetch, stripCommentsAndStrings } from "../../scripts/check-no-bare-fetch.mjs";

// vitest 的工作目录是 apps/web。
const appRoot = process.cwd();
const checker = resolve(appRoot, "scripts/check-no-bare-fetch.mjs");
const violationFixture = resolve(appRoot, "tests/fixtures/bare-fetch-violation.fixture.tsx");

function runChecker(args: string[] = []): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [checker, ...args], {
      cwd: appRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("静态检查：业务代码不得直接调用 fetch", () => {
  it("当前代码零违规，也不误报", () => {
    const result = runChecker();
    expect(result.status).toBe(0);
    expect(result.output).toContain("检查通过");
  });

  it("反例夹具会被拦下，并指出文件与行号", () => {
    const result = runChecker(["tests/fixtures/bare-fetch-violation.fixture.tsx"]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("检查未通过");
    expect(result.output).toMatch(/bare-fetch-violation\.fixture\.tsx:5:\d+/);
    expect(result.output).toContain("allowed-network-egress.json");
  });

  it("认得出借全局对象绕开的写法", () => {
    for (const source of ["window.fetch('/api/projects')", "globalThis.fetch('/api/projects')", "self.fetch('/x')"]) {
      expect(findBareFetch(source)).toHaveLength(1);
    }
  });

  it("不把注释、字符串与同名方法当成违规", () => {
    const source = [
      "// 这里说明为什么不要 fetch(",
      "/* fetch('/api/projects') 只是举例 */",
      'const hint = "请勿直接 fetch(/api)";',
      "const tpl = `fetch(${url})`;",
      "await client.fetch('/api/projects');",
      "await prefetch('/api/projects');",
      "const refetch = () => reload();"
    ].join("\n");

    expect(findBareFetch(source)).toEqual([]);
  });

  it("模板串里的插值仍会被检查", () => {
    expect(findBareFetch("const tpl = `${fetch('/api/projects')}`;")).toHaveLength(1);
  });

  it("剥离注释与字符串后行数不变，行号可信", () => {
    const source = readFileSync(violationFixture, "utf8");
    expect(stripCommentsAndStrings(source).split("\n")).toHaveLength(source.split("\n").length);
  });
});
