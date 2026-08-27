import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildDistributionBrief } from "../.claude/tools/distribution-brief.mjs";
import { getStrategyFormula } from "../.claude/tools/get-strategy-formula.mjs";
import {
  writeStageExecutionSpec,
  writeStageExecutionStrategy
} from "../.claude/skills/_shared/scripts/stage-execution-spec.mjs";

const agentsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stages = ["outline_rewrite", "character_rewrite", "trial_generate", "full_generate"];
const knowledgeStages = ["world_view", ...stages];

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createKnowledgeDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE script_library_principles (
      id TEXT PRIMARY KEY, title TEXT, stages_json TEXT, statement TEXT,
      applies_when_json TEXT, fails_or_changes_when_json TEXT,
      review_criteria_json TEXT, skill_keys_json TEXT, version INTEGER,
      source_count INTEGER, status TEXT
    );
    CREATE TABLE script_library_formulas (
      id TEXT PRIMARY KEY, category TEXT, name TEXT, stages_json TEXT,
      creative_decision TEXT, creative_problem TEXT, applicable_tags_json TEXT,
      source_count INTEGER, revision INTEGER, content_json TEXT, status TEXT
    );
  `);
  const principle = db.prepare(`
    INSERT INTO script_library_principles (
      id, title, stages_json, statement, applies_when_json,
      fails_or_changes_when_json, review_criteria_json, skill_keys_json,
      version, source_count, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 3, 'active')
  `);
  const formula = db.prepare(`
    INSERT INTO script_library_formulas (
      id, category, name, stages_json, creative_decision, creative_problem,
      applicable_tags_json, source_count, revision, content_json, status
    ) VALUES (?, 'story_engine', ?, ?, ?, ?, ?, 3, 1, ?, 'active')
  `);
  stages.forEach((stage) => {
    const usage = `当前${stage}需要强化主角主动选择与因果推进时使用`;
    principle.run(
      `principle-${stage}`,
      `${stage}主动选择原则`,
      JSON.stringify([stage]),
      "每次关键推进都由角色可观察的主动选择造成。",
      JSON.stringify(["当前阶段需要推进主线或关系变化时"]),
      JSON.stringify(["原始剧本明确要求角色被动承受且不可改写时"]),
      JSON.stringify(["关键转折前存在明确选择，转折后局面发生可观察变化"]),
      JSON.stringify([`stage:${stage}`])
    );
    formula.run(
      `formula-${stage}`,
      `${stage}主动推进公式`,
      JSON.stringify([stage]),
      usage,
      usage,
      JSON.stringify(["悬疑", "女频"]),
      JSON.stringify({
        usage_scenario: usage,
        not_applicable: ["原剧明确禁止改变当前事件因果时"],
        goal: "让主角通过选择推动当前阶段的局面变化。",
        core_formula: "明确压力 -> 主角选择 -> 行动结果 -> 新问题",
        conditions: ["大纲已确定当前事件和角色目标"],
        variables: ["压力来源", "选择方式", "行动代价"],
        steps: ["确认当前压力", "设计主动选择", "写出行动结果", "留下后续问题"],
        mechanism: "选择把角色目标与剧情结果连接为因果链。",
        observable_checks: ["删除主角选择后，当前转折不能照常发生"],
        failure_modes: ["只写态度变化，没有行动结果"],
        rewrite_usage: "保留原剧事件和结局，只优化主动选择与事件之间的连接。",
        original_usage: "从角色目标出发建立新的选择与结果。",
        genre_adaptations: [{ tags: ["悬疑"], guidance: "让选择改变证据或信息位置。" }]
      })
    );
  });
  db.close();
}

test("五个创作阶段只在 Skill 工具清单中保留一份公式读取命令", async () => {
  for (const stage of knowledgeStages) {
    const skill = await fs.readFile(path.join(agentsRoot, ".claude", "skills", stage, "SKILL.md"), "utf8");
    assert.match(skill, /## 快速开始/u);
    assert.match(skill, /## 生成流程/u);
    assert.doesNotMatch(skill, /## 工作流程/u);
    assert.match(skill, /\| 首次生成 \|/u);
    assert.match(skill, /\| 修复生成结果 \|/u);
    assert.match(skill, /\| 修改已完成/u);
    assert.match(skill, /公式表只列使用场景和公式名称/u);
    assert.equal((skill.match(/node \.claude\/tools\/get-strategy-formula\.mjs/gu) || []).length, 1);
    assert.match(skill, new RegExp(`--stage ${stage} --name <公式名称>`, "u"));
  }
});

test("完整剧本快速路由要求修复闭环并区分整稿修改", async () => {
  const skill = await fs.readFile(
    path.join(agentsRoot, ".claude", "skills", "full_generate", "SKILL.md"),
    "utf8"
  );
  assert.match(skill, /`trial_continuation`[\s\S]*每轮修改后都要合并全稿并检查/u);
  assert.match(skill, /`full_revision`[\s\S]*只修改完整剧本中的命中内容并重新检查/u);
  assert.match(skill, /未通过时继续定向修复，直到通过/u);
  assert.match(skill, /`full_revision`[\s\S]*直接修改完整剧本/u);
});

async function createWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(agentsRoot, "workspaces", "stage-spec-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const brief = {
    ...buildDistributionBrief({ targetCountry: "美国", targetLocale: "en-US", taskType: "rewrite" }),
    theme: ["悬疑"],
    setting: ["大女主"],
    background: ["现代", "都市"],
    audience: ["女频"]
  };
  await writeJson(path.join(workspace, "1.1-user-input.json"), {
    project: {
      project_name: "阶段策略测试",
      task_type: "rewrite",
      target_region: "北美",
      distribution_brief: brief,
      extra_requirements: "保留原剧主线，只优化当前阶段。",
      source_script: { display_name: "原始剧本", output_path: "output/原始剧本.md" }
    }
  });
  await fs.mkdir(path.join(workspace, "output"), { recursive: true });
  await fs.writeFile(path.join(workspace, "output/原始剧本.md"), "# 原始剧本\n", "utf8");
  await writeJson(path.join(workspace, "2.1-world-view.json"), {
    "世界观描述": "现代都市中，公开证据决定人物的行动空间。",
    "关键概念映射": []
  });
  return workspace;
}

test("完整剧本执行规范明确写入初始化模式", async (t) => {
  const workspace = await createWorkspace(t);
  const spec = await writeStageExecutionSpec({
    workspace,
    stage: "full_generate",
    userInput: JSON.parse(await fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8")),
    outputFile: "output/完整剧本.md",
    options: {
      jobId: "job-full-mode",
      executionContext: {
        "执行模式": "trial_continuation",
        "执行方式": "保留已确认试稿，只完成试稿范围之后的剧集"
      }
    }
  });
  const specText = await fs.readFile(spec.paths.markdown, "utf8");
  assert.match(specText, /- 执行模式：trial_continuation/u);
  assert.match(specText, /- 执行方式：保留已确认试稿，只完成试稿范围之后的剧集/u);
});

test("四个改写阶段分别生成事实规范、原则和公式目录，不加载案例卡", async (t) => {
  const workspace = await createWorkspace(t);
  const dbPath = path.join(workspace, "knowledge.sqlite3");
  createKnowledgeDb(dbPath);
  const previousJobId = process.env.ORCA_AGENT_JOB_ID;
  try {
    for (const stage of stages) {
      const jobId = `job-${stage}`;
      process.env.ORCA_AGENT_JOB_ID = jobId;
      const spec = await writeStageExecutionSpec({
        workspace,
        stage,
        userInput: JSON.parse(await fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8")),
        outputFile: `output/${stage}.md`,
        options: { jobId }
      });
      const strategy = await writeStageExecutionStrategy({
        workspace,
        stage,
        userInput: JSON.parse(await fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8")),
        options: { jobId, knowledgeDbPath: dbPath }
      });
      const specText = await fs.readFile(spec.paths.markdown, "utf8");
      const strategyText = await fs.readFile(strategy.paths.strategy_markdown, "utf8");
      assert.match(specText, /保留原剧主线，只优化当前阶段/u);
      assert.match(specText, /现代都市中，公开证据决定人物的行动空间/u);
      assert.match(strategyText, new RegExp(`${stage}主动选择原则`, "u"));
      assert.match(strategyText, new RegExp(`${stage}主动推进公式`, "u"));
      assert.match(strategyText, /\| 使用场景 \| 公式名称 \|/u);
      assert.doesNotMatch(strategyText, /执行脚本|get-strategy-formula\.mjs|--workspace|--stage/u);
      assert.doesNotMatch(strategyText, /成立原因|案例卡/u);
      assert.equal(strategy.snapshot.principles.length, 1);
      assert.equal(strategy.snapshot.formulas.length, 1);
      const formula = await getStrategyFormula({
        workspace: path.relative(agentsRoot, workspace),
        stage,
        name: `${stage}主动推进公式`
      });
      assert.equal(formula["公式名称"], `${stage}主动推进公式`);
      assert.match(formula["当前场景用法"], /保留原剧事件和结局/u);
    }
  } finally {
    if (previousJobId === undefined) delete process.env.ORCA_AGENT_JOB_ID;
    else process.env.ORCA_AGENT_JOB_ID = previousJobId;
  }
});

test("任一标签未确定时不访问知识库，也不返回原则或公式", async (t) => {
  const workspace = await createWorkspace(t);
  const inputPath = path.join(workspace, "1.1-user-input.json");
  const userInput = JSON.parse(await fs.readFile(inputPath, "utf8"));
  userInput.project.distribution_brief.setting = ["自动适配"];
  await writeJson(inputPath, userInput);
  await writeStageExecutionSpec({ workspace, stage: "outline_rewrite", userInput, options: { jobId: "unresolved" } });
  const strategy = await writeStageExecutionStrategy({
    workspace,
    stage: "outline_rewrite",
    userInput,
    options: { jobId: "unresolved", knowledgeDbPath: path.join(workspace, "不存在.sqlite3") }
  });
  assert.equal(strategy.snapshot.knowledge_status, "skipped_unresolved_profile");
  assert.deepEqual(strategy.snapshot.principles, []);
  assert.deepEqual(strategy.snapshot.formulas, []);
  assert.match(await fs.readFile(strategy.paths.strategy_markdown, "utf8"), /本次不获取创作原则和策略公式/u);
});
