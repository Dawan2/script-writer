#!/usr/bin/env node
// 依次跑完全部测试套件，再统一汇总。
// 之前用 && 串接，第一个套件失败就中断，后面的套件拿不到输出；
// 这里改为全部跑完，只要有一个套件失败仍以非零退出，判定标准不变。
import { spawnSync } from "node:child_process";

const SUITES = [
  { key: "agent", label: "Agent 脚本", script: "test:agent" },
  { key: "api", label: "服务端接口", script: "test:api" },
  { key: "zdebug", label: "排障工具", script: "test:zdebug" },
  { key: "web", label: "前端", script: "test:web" }
];

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const suites = requested.length ? SUITES.filter((suite) => requested.includes(suite.key)) : SUITES;

const unknown = requested.filter((arg) => !SUITES.some((suite) => suite.key === arg));
if (unknown.length) {
  console.error(`未知的测试套件：${unknown.join("、")}`);
  console.error(`可选：${SUITES.map((suite) => suite.key).join("、")}`);
  process.exit(2);
}

const results = [];
for (const suite of suites) {
  console.log(`\n=== ${suite.label}（npm run ${suite.script}）===`);
  const started = Date.now();
  const child = spawnSync("npm", ["run", suite.script], { stdio: "inherit", shell: false });
  const code = child.status ?? 1;
  results.push({ ...suite, code, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  if (child.error) console.error(`无法启动 ${suite.script}：${child.error.message}`);
}

console.log("\n=== 测试汇总 ===");
for (const result of results) {
  console.log(`${result.code === 0 ? "通过" : "失败"}  ${result.label}（npm run ${result.script}，${result.seconds}s）`);
}

const failed = results.filter((result) => result.code !== 0);
if (failed.length) {
  console.log(`\n${failed.length} 个套件失败：${failed.map((result) => result.script).join("、")}`);
  process.exit(1);
}
console.log("\n全部套件通过。");
