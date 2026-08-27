import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE script_library_principles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  stages_json TEXT NOT NULL DEFAULT '[]',
  statement TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  applies_when_json TEXT NOT NULL DEFAULT '[]',
  fails_or_changes_when_json TEXT NOT NULL DEFAULT '[]',
  review_criteria_json TEXT NOT NULL DEFAULT '[]',
  skill_keys_json TEXT NOT NULL DEFAULT '[]',
  source_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE script_library_formulas (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  stages_json TEXT NOT NULL DEFAULT '[]',
  creative_decision TEXT NOT NULL DEFAULT '',
  creative_problem TEXT NOT NULL DEFAULT '',
  applicable_tags_json TEXT NOT NULL DEFAULT '[]',
  source_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  revision INTEGER NOT NULL DEFAULT 1,
  content_json TEXT NOT NULL DEFAULT '{}'
);
`;

const WORLD_VIEW_PRINCIPLE = {
  id: "principle-world-rule-boundary",
  title: "世界规则边界一致",
  stages: ["world_view"],
  statement: "关键世界规则必须明确边界并保持一致",
  applies_when: ["新世界观引入了原剧没有的权力、身份或资源规则"],
  fails_or_changes_when: ["目标地区规则要求删除该设定"],
  review_criteria: ["每条关键世界规则都写明了适用范围与失效条件"],
};

const WORLD_VIEW_FORMULA = {
  id: "formula-world-rule-swap",
  category: "world_rule",
  name: "权力外壳置换",
  stages: ["world_view"],
  usage_scenario: "需要把原剧的本土权力结构换成目标地区可信的同类结构时",
  content: {
    usage_scenario: "需要把原剧的本土权力结构换成目标地区可信的同类结构时",
    not_applicable: ["原剧权力结构本身就是故事卖点且不可替换"],
    goal: "让权力压制在目标地区语境下依然成立",
    core_formula: "保留权力关系与压制强度，只替换承载权力的机构与身份",
    conditions: ["已确认目标地区的对应机构"],
    variables: ["承载权力的机构", "身份称谓"],
    steps: [
      "列出原剧中产生压制的权力关系",
      "为每条关系找到目标地区的等价机构",
      "改写机构与身份称谓，保持压制强度不变",
    ],
  },
};

/**
 * 建一个最小可用的剧本知识库，用于验证「取到知识」这条路径。
 * 不建库时执行策略只能验证「没取到知识」的分支。
 */
export async function createKnowledgeLibrary(directory, {
  principles = [WORLD_VIEW_PRINCIPLE],
  formulas = [WORLD_VIEW_FORMULA],
} = {}) {
  await fs.mkdir(directory, { recursive: true });
  const dbPath = path.join(directory, "workbench.sqlite3");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCHEMA);
    const insertPrinciple = db.prepare(`
      INSERT INTO script_library_principles
        (id, title, stages_json, statement, applies_when_json, fails_or_changes_when_json,
         review_criteria_json, skill_keys_json, source_count, status, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)
    `);
    for (const principle of principles) {
      insertPrinciple.run(
        principle.id,
        principle.title,
        JSON.stringify(principle.stages),
        principle.statement,
        JSON.stringify(principle.applies_when),
        JSON.stringify(principle.fails_or_changes_when),
        JSON.stringify(principle.review_criteria),
        JSON.stringify(principle.skill_keys || []),
        principle.source_count ?? 3,
      );
    }
    const insertFormula = db.prepare(`
      INSERT INTO script_library_formulas
        (id, category, name, stages_json, creative_decision, creative_problem,
         applicable_tags_json, source_count, status, revision, content_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)
    `);
    for (const formula of formulas) {
      insertFormula.run(
        formula.id,
        formula.category,
        formula.name,
        JSON.stringify(formula.stages),
        formula.usage_scenario,
        formula.usage_scenario,
        JSON.stringify(formula.applicable_tags || []),
        formula.source_count ?? 5,
        JSON.stringify(formula.content),
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

/** 建一个表结构齐全但没有任何已启用知识的库，等同于全新部署后的状态。 */
export async function createEmptyKnowledgeLibrary(directory) {
  return createKnowledgeLibrary(directory, { principles: [], formulas: [] });
}
