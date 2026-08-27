// 实验三：创作知识库为空时，执行策略的验收门禁是否放行（对应 A-01）。
//
// 用法：cd Agents && node ../docs/iteration/cycle-01/evidence/w1-失败路径实测/probe-knowledge-status.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildDistributionBrief } from "../../../../../Agents/.claude/tools/distribution-brief.mjs";
import { initializeWorldView } from "../../../../../Agents/.claude/skills/world_view/scripts/init-world-view.mjs";
import { getWorldViewExecutionStrategy } from "../../../../../Agents/.claude/skills/world_view/scripts/get-execution-strategy.mjs";
import { stageExecutionStrategyIssues } from "../../../../../Agents/.claude/skills/_shared/scripts/stage-execution-spec.mjs";

const agentsRoot = path.resolve(import.meta.dirname, "../../../../../Agents");
const workspace = await fs.mkdtemp(path.join(agentsRoot, "workspaces", "knowledge-probe-"));

const brief = {
  ...buildDistributionBrief({ targetCountry: "美国", targetLocale: "en-US", taskType: "rewrite" }),
  theme: ["悬疑"],
  setting: ["大女主"],
  background: ["现代", "都市"],
  audience: ["女频"],
};
await fs.writeFile(path.join(workspace, "1.1-user-input.json"), JSON.stringify({
  project: {
    project_name: "知识库探针",
    task_type: "rewrite",
    target_region: "北美",
    distribution_brief: brief,
    source_script: { display_name: "原始剧本", output_path: "output/原始剧本.md" },
  },
}, null, 2), "utf8");
await fs.writeFile(path.join(workspace, "1.2-project-progress.json"), JSON.stringify({
  stages: { project_init: { status: "completed" }, world_view: { status: "pending" } },
  audit: {},
}, null, 2), "utf8");
await fs.mkdir(path.join(workspace, "output"), { recursive: true });
await fs.writeFile(path.join(workspace, "output/原始剧本.md"), "# 原始剧本\n", "utf8");

// 表结构齐全但没有任何已启用知识，等同于全新部署后的默认状态
const dbPath = path.join(workspace, "workbench.sqlite3");
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE script_library_principles (
    id TEXT PRIMARY KEY, title TEXT, stages_json TEXT, statement TEXT,
    applies_when_json TEXT, fails_or_changes_when_json TEXT, review_criteria_json TEXT,
    skill_keys_json TEXT, version INTEGER, source_count INTEGER, status TEXT);
  CREATE TABLE script_library_formulas (
    id TEXT PRIMARY KEY, category TEXT, name TEXT, stages_json TEXT,
    creative_decision TEXT, creative_problem TEXT, applicable_tags_json TEXT,
    source_count INTEGER, revision INTEGER, content_json TEXT, status TEXT);
`);
db.close();

await initializeWorldView(workspace, "tester");
const result = await getWorldViewExecutionStrategy(workspace, { knowledgeDbPath: dbPath });
const userInput = JSON.parse(await fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8"));
const issues = await stageExecutionStrategyIssues(workspace, "world_view", userInput, { knowledgeDbPath: dbPath });

console.log("knowledge_status =", result.knowledge_status);
console.log("principle_count  =", result.principle_count);
console.log("formula_count    =", result.formula_count);
console.log("门禁 issues      =", JSON.stringify(issues));
console.log("--- 执行策略.md ---");
console.log(await fs.readFile(result.execution_strategy_file, "utf8"));

await fs.rm(workspace, { recursive: true, force: true });
