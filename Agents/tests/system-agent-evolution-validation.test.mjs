import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateEvolutionExecution } from "../.claude/skills/system-agent-evolution/scripts/evolution-contract-tools.mjs";

const execFileAsync = promisify(execFile);
const agentsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportValidator = path.join(agentsRoot, ".claude/skills/system-agent-evolution/scripts/validate-evolution-report.mjs");

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-evolution-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function validReport(citation = "event:30") {
  return `# Agent 进化分析报告

## 分析范围

本轮覆盖了多个已完成任务和失败任务，用于核对重复出现的问题。

## 证据概览

任务失败记录和人工调整记录均可追溯，适合形成有限范围的改进建议。

## 优化建议

### 收紧工具参数校验
- 现象：同类参数错误导致任务失败并触发了后续重试。
- 证据：[${citation}] [job:20]
- 根因假设：输入字段校验与修复提示没有复用同一份参数约束。
- 调整对象：Agents/.claude/skills/trial_generate/scripts/check-trial.mjs
- 具体方案：补充参数校验与可操作的修复提示，并复用统一的字段约束。
- 预期收益：降低同类参数错误和无效重试次数，缩短任务恢复时间。
- 副作用：历史输入需要经过一次兼容性检查，避免影响已存在的调用方式。
- 验收指标：相同错误样本能够给出修复提示，现有通过样例继续保持通过。
- 回滚点：保留当前校验版本，发现兼容问题时恢复到原有参数处理逻辑。

## 执行优先级

先验证参数校验的兼容性，再安排对实际失败样本的回归检查。

## 验证与回滚

回归历史通过样例和失败样例，验证不出现质量或兼容性回退后再保留改动。
`;
}

function noChangeReport() {
  return `# Agent 进化分析报告

## 分析范围

本轮没有收集到足够的跨项目样本，不能据此推断系统级问题。

## 证据概览

现有记录无法形成可复核的重复故障或人工返工关联，不能扩大解释。

## 优化建议

### 不建议本次修改
- 判断：当前时间窗口没有足够的跨项目证据，不应提出生产 Skill 调整。
- 证据缺口：缺少重复失败、人工返工和质量指标之间可追溯的关联。
- 后续采集：继续收集后续窗口的失败事件、修订记录和成本变化后再分析。

## 执行优先级

本轮不执行改动，优先保证后续证据采集的完整性和可追溯性。

## 验证与回滚

本轮没有发布改动；后续提案须回放样例并保留现有版本作为回滚点。
`;
}

test("系统进化分析校验脚本接受后台证据格式并拒绝未知引用", async (t) => {
  const directory = await temporaryDirectory(t);
  const evidencePath = path.join(directory, "evidence.json");
  const reportPath = path.join(directory, "report.md");
  await fs.writeFile(evidencePath, JSON.stringify({
    jobs: [{ ref: "job:20" }],
    failures: [{ ref: "event:30" }]
  }), "utf8");
  await fs.writeFile(reportPath, validReport(), "utf8");

  const { stdout } = await execFileAsync(process.execPath, [reportValidator, "--evidence", evidencePath, "--report", reportPath]);
  assert.equal(JSON.parse(stdout).ok, true);

  await fs.writeFile(reportPath, validReport("event:999"), "utf8");
  await assert.rejects(
    execFileAsync(process.execPath, [reportValidator, "--evidence", evidencePath, "--report", reportPath]),
    (error) => {
      const payload = JSON.parse(error.stderr);
      assert.equal(payload.ok, false);
      assert.match(payload.message, /不存在的证据/u);
      return true;
    }
  );

  await fs.writeFile(reportPath, noChangeReport(), "utf8");
  const noChange = await execFileAsync(process.execPath, [reportValidator, "--evidence", evidencePath, "--report", reportPath]);
  assert.equal(JSON.parse(noChange.stdout).ok, true);
});

test("系统进化执行记录必须镜像后端验证结果", async (t) => {
  const directory = await temporaryDirectory(t);
  const executionPath = path.join(directory, "execution.md");
  const verificationPath = path.join(directory, "verification.json");
  const changedFile = "Agents/.claude/skills/trial_generate/SKILL.md";
  await fs.writeFile(executionPath, `# 执行记录

## 执行范围

只实施管理员已审阅的参数校验优化，不扩大到其他生产模块。

## 实际变更

已修改 ${changedFile}，补充参数校验和面向使用者的修复提示。

## 未执行项及原因

未修改其他 Skill，因为本次没有获得对应的审阅结论和执行要求。

## 指标对照

保留当前失败率和通过样例作为基线，后续根据同类错误数量比较优化收益。

## 回滚方法

保留改动前版本；出现兼容性问题时恢复 ${changedFile} 的原有内容。

## 系统验证结果

npm test 与 npm run check 均已通过，实际变更文件已按后端快照核对。
`, "utf8");
  await fs.writeFile(verificationPath, JSON.stringify({
    schema_version: "1.0.0",
    status: "passed",
    changed_files: [changedFile],
    commands: [
      { command: "npm test", status: "passed" },
      { command: "npm run check", status: "passed" }
    ]
  }), "utf8");

  const result = await validateEvolutionExecution({ executionPath, verificationPath });
  assert.equal(result.changed_file_count, 1);
});
