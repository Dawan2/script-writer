import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createEmptyKnowledgeLibrary, createKnowledgeLibrary } from "./helpers/knowledge-library.mjs";
import { buildDistributionBrief } from "../.claude/tools/distribution-brief.mjs";
import { resolveScriptProfile } from "../.claude/tools/resolve-script-profile.mjs";
import { initializeWorldView } from "../.claude/skills/world_view/scripts/init-world-view.mjs";
import { getWorldViewExecutionStrategy } from "../.claude/skills/world_view/scripts/get-execution-strategy.mjs";
import { checkWorldView } from "../.claude/skills/world_view/scripts/check-world-view.mjs";
import { getStrategyFormula } from "../.claude/tools/get-strategy-formula.mjs";
import {
  STAGE_EXECUTION_CONFIG,
  stageExecutionStrategyIssues
} from "../.claude/skills/_shared/scripts/stage-execution-spec.mjs";

const agentsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("公共执行规范模块包含世界观和后续四个创作阶段", () => {
  assert.deepEqual(Object.keys(STAGE_EXECUTION_CONFIG), [
    "world_view",
    "outline_rewrite",
    "character_rewrite",
    "trial_generate",
    "full_generate"
  ]);
});

test("公共执行规范通过阶段配置表达差异，不硬编码世界观分支", async () => {
  const source = await fs.readFile(
    path.join(agentsRoot, ".claude/skills/_shared/scripts/stage-execution-spec.mjs"),
    "utf8"
  );
  assert.doesNotMatch(source, /stage\s*===\s*["']world_view["']/u);
  assert.equal(STAGE_EXECUTION_CONFIG.world_view.execution_target, "世界观创作");
  assert.deepEqual(STAGE_EXECUTION_CONFIG.world_view.output_contract.top_level_fields, ["世界观描述", "关键概念映射"]);
});

async function createKnowledgeDb(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orca-knowledge-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return createKnowledgeLibrary(directory);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createWorkspace(t, { taskType = "rewrite", useFormulas = false, autoProfile = false } = {}) {
  const workspace = await fs.mkdtemp(path.join(agentsRoot, "workspaces", "world-view-spec-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const brief = {
    ...buildDistributionBrief({ targetCountry: "美国", targetLocale: "en-US", taskType }),
    theme: autoProfile ? ["自动适配"] : ["悬疑"],
    setting: autoProfile ? ["自动适配"] : ["大女主"],
    background: autoProfile ? ["自动适配"] : ["现代", "都市"],
    audience: autoProfile ? ["自动适配"] : ["女频"]
  };
  await writeJson(path.join(workspace, "1.1-user-input.json"), {
    project: {
      project_name: "规范测试",
      task_type: taskType,
      target_region: "北美",
      knowledge_policy: { world_view: { use_formulas: useFormulas } },
      distribution_brief: brief,
      source_script: { display_name: "原始剧本", output_path: "output/原始剧本.md" }
    }
  });
  await writeJson(path.join(workspace, "1.2-project-progress.json"), {
    stages: { project_init: { status: "completed" }, world_view: { status: "pending" } },
    audit: {}
  });
  await fs.mkdir(path.join(workspace, "output"), { recursive: true });
  await fs.writeFile(path.join(workspace, "output/原始剧本.md"), "# 原始剧本\n", "utf8");
  return workspace;
}

test("世界观初始化只生成事实规范，执行策略单独加载原则且改写场景不加载公式", async (t) => {
  const workspace = await createWorkspace(t);
  const knowledgeDbPath = await createKnowledgeDb(t);
  const first = await initializeWorldView(workspace, "tester");
  assert.equal(first.execution_spec_directory, path.dirname(first.execution_spec_file));
  const spec = await fs.readFile(first.execution_spec_file, "utf8");
  assert.match(spec, /^# 执行规范/u);
  assert.doesNotMatch(spec, /关键世界规则必须明确边界并保持一致/u);
  assert.doesNotMatch(spec, /## 执行原则/u);
  assert.doesNotMatch(spec, /## 策略公式/u);

  const strategyResult = await getWorldViewExecutionStrategy(workspace, { knowledgeDbPath });
  assert.equal(strategyResult.knowledge_status, "loaded");
  const strategy = await fs.readFile(strategyResult.execution_strategy_file, "utf8");
  const strategySnapshot = JSON.parse(await fs.readFile(
    path.join(path.dirname(strategyResult.execution_strategy_file), "execution-strategy.json"),
    "utf8"
  ));
  assert.match(strategy, /关键世界规则必须明确边界并保持一致/u);
  assert.doesNotMatch(strategy, /- 成立原因：/u);
  assert.equal(Object.hasOwn(strategySnapshot.principles[0], "rationale"), false);
  assert.doesNotMatch(strategy, /## 策略公式/u);

  await fs.writeFile(
    path.join(workspace, "2.1-world-view.json"),
    JSON.stringify({ 世界观描述: "一个由公开证据决定权限的城市。", 关键概念映射: [] }),
    "utf8"
  );
  assert.equal((await checkWorldView(workspace, "tester")).ok, true);
  const before = await fs.readFile(path.join(workspace, "2.1-world-view.json"), "utf8");
  const second = await initializeWorldView(workspace, "tester");
  assert.equal(await fs.readFile(path.join(workspace, "2.1-world-view.json"), "utf8"), before);
  assert.doesNotMatch(await fs.readFile(second.execution_spec_file, "utf8"), /## 执行原则/u);
});

test("标签确定前执行策略不获取任何知识，重新初始化后可按名称读取公式", async (t) => {
  const workspace = await createWorkspace(t, { useFormulas: true, autoProfile: true });
  await initializeWorldView(workspace, "tester");
  const skipped = await getWorldViewExecutionStrategy(workspace, {
    knowledgeDbPath: path.join(workspace, "不应访问的知识库.sqlite3")
  });
  assert.equal(skipped.knowledge_status, "skipped_unresolved_profile");
  assert.equal(skipped.principle_count, 0);
  assert.equal(skipped.formula_count, 0);
  assert.match(await fs.readFile(skipped.execution_strategy_file, "utf8"), /本次不获取创作原则和策略公式/u);
  const unresolvedInput = JSON.parse(await fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8"));
  assert.deepEqual(await stageExecutionStrategyIssues(workspace, "world_view", unresolvedInput), []);
  await assert.rejects(
    () => getStrategyFormula({
      workspace: path.relative(path.resolve("."), workspace),
      stage: "world_view",
      name: "任意公式"
    }),
    /剧本标签尚未确定/u
  );
  await resolveScriptProfile({
    workspace,
    stage: "world_view",
    updatedBy: "tester",
    theme: "脑洞",
    setting: "异能",
    background: "现代,都市",
    audience: "女频"
  });
  const refreshed = await initializeWorldView(workspace, "tester");
  const strategyResult = await getWorldViewExecutionStrategy(workspace, {
    knowledgeDbPath: await createKnowledgeDb(t)
  });
  assert.equal(strategyResult.knowledge_status, "loaded");
  const current = await fs.readFile(strategyResult.execution_strategy_file, "utf8");
  assert.match(current, /## 策略公式/u);
  const formulaName = current.match(/^\| (?!使用场景|---)[^|]+ \| ([^|]+) \|$/mu)?.[1]?.trim();
  assert.ok(formulaName);
  const result = await getStrategyFormula({
    workspace: path.relative(path.resolve("."), workspace),
    stage: "world_view",
    name: formulaName
  });
  assert.equal(result["公式名称"], formulaName);
  assert.ok(Array.isArray(result["使用方法"]));
});

test("任一类标签缺失时不获取原则和公式", async (t) => {
  const workspace = await createWorkspace(t, { useFormulas: true });
  const inputPath = path.join(workspace, "1.1-user-input.json");
  const userInput = JSON.parse(await fs.readFile(inputPath, "utf8"));
  userInput.project.distribution_brief.theme = [];
  await writeJson(inputPath, userInput);
  await initializeWorldView(workspace, "tester");

  const skipped = await getWorldViewExecutionStrategy(workspace, {
    knowledgeDbPath: path.join(workspace, "不应访问的知识库.sqlite3")
  });

  assert.equal(skipped.knowledge_status, "skipped_unresolved_profile");
  assert.equal(skipped.principle_count, 0);
  assert.equal(skipped.formula_count, 0);
  assert.match(await fs.readFile(skipped.execution_strategy_file, "utf8"), /本次不获取创作原则和策略公式/u);
  assert.deepEqual(await stageExecutionStrategyIssues(workspace, "world_view", userInput), []);

  const checked = await checkWorldView(workspace, "tester");
  assert.equal(checked.ok, false);
  assert.match(checked.issues.join("\n"), /剧本设定尚未完成：主题不能为空/u);
  assert.doesNotMatch(checked.issues.join("\n"), /策略公式尚未获取/u);
});

test("公式是否可用由当前场景策略决定，而不是由改写类型写死", async (t) => {
  const workspace = await createWorkspace(t, { useFormulas: true });
  const result = await initializeWorldView(workspace, "tester");
  const spec = await fs.readFile(result.execution_spec_file, "utf8");
  assert.doesNotMatch(spec, /## 策略公式/u);
  const strategyResult = await getWorldViewExecutionStrategy(workspace, {
    knowledgeDbPath: await createKnowledgeDb(t)
  });
  const strategy = await fs.readFile(strategyResult.execution_strategy_file, "utf8");
  assert.match(strategy, /请遵循`执行原则`，按需使用`策略公式`/u);
  assert.match(strategy, /## 策略公式/u);
  assert.match(strategy, /\| 使用场景 \| 公式名称 \|/u);
  assert.doesNotMatch(strategy, /执行脚本|get-strategy-formula\.mjs|--workspace|--stage/u);
});

test("知识库为空时执行策略如实标记未取到知识，并在文件中说明", async (t) => {
  const workspace = await createWorkspace(t, { useFormulas: true });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orca-knowledge-empty-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await initializeWorldView(workspace, "tester");

  const strategyResult = await getWorldViewExecutionStrategy(workspace, {
    knowledgeDbPath: await createEmptyKnowledgeLibrary(directory)
  });

  assert.equal(strategyResult.knowledge_status, "empty");
  assert.equal(strategyResult.principle_count, 0);
  const strategy = await fs.readFile(strategyResult.execution_strategy_file, "utf8");
  assert.match(strategy, /创作知识库中还没有适用于本阶段和当前剧本标签的创作原则/u);
  assert.doesNotMatch(strategy, /## 执行原则/u);
  assert.doesNotMatch(strategy, /剧本标签尚未全部确定/u);
});

test("执行策略谎称已取到创作原则时门禁不放行", async (t) => {
  const workspace = await createWorkspace(t);
  await initializeWorldView(workspace, "tester");
  const strategyResult = await getWorldViewExecutionStrategy(workspace, {
    knowledgeDbPath: await createKnowledgeDb(t)
  });
  const snapshotPath = path.join(path.dirname(strategyResult.execution_strategy_file), "execution-strategy.json");
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  snapshot.principles = [];
  await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const input = JSON.parse(await fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8"));

  const issues = await stageExecutionStrategyIssues(workspace, "world_view", input);

  assert.match(issues.join("\n"), /标记为已获取创作原则，实际一条都没有/u);
});

test("旧执行策略快照含成立原因时要求重新生成", async (t) => {
  const workspace = await createWorkspace(t);
  await initializeWorldView(workspace, "tester");
  const strategyResult = await getWorldViewExecutionStrategy(workspace, {
    knowledgeDbPath: await createKnowledgeDb(t)
  });
  const strategyPath = strategyResult.execution_strategy_file;
  const snapshotPath = path.join(path.dirname(strategyPath), "execution-strategy.json");
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  snapshot.principles[0].rationale = "仅用于测试的历史解释";
  await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const input = JSON.parse(await fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8"));
  const issues = await stageExecutionStrategyIssues(workspace, "world_view", input);
  assert.match(issues.join("\n"), /成立原因/u);
});
