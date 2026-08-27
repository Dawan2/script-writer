#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getAdaptationContext } from "../../../tools/get-adaptation-context.mjs";
import { cleanText, normalizeLocale } from "../../../tools/distribution-brief.mjs";
import { resolveRegionRules } from "../../../tools/get-region-rules.mjs";
import { summarizeUserRequirements } from "../../../tools/get-user-requirements.mjs";
import { pendingScriptProfileFields } from "../../../tools/script-profile.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const defaultKnowledgeDbPath = path.resolve(agentRoot, "../data/workbench.sqlite3");

const CREATIVE_STAGE_DEFAULTS = Object.freeze({
  include_adaptation_context: true,
  include_script_profile: true,
  formula_policy: "enabled",
  formula_label: "策略公式",
  empty_requirements: "本阶段没有额外要求；仍须依据上游产物、原始剧本和 Skill 原则完成交付。"
});

export const STAGE_EXECUTION_CONFIG = Object.freeze({
  world_view: {
    label: "世界观",
    output_file: "2.1-world-view.json",
    next_skill: "outline_rewrite",
    include_adaptation_context: false,
    include_script_profile: false,
    formula_policy: "creation_only",
    formula_label: "世界观公式",
    execution_target: "世界观创作",
    empty_requirements: "本阶段没有额外要求；仍须依据原始材料和世界观构建原则完成交付。",
    init_tool: "初始化世界观",
    output_contract: {
      top_level_fields: ["世界观描述", "关键概念映射"],
      mapping_fields: ["原剧本概念", "映射后概念"]
    }
  },
  outline_rewrite: {
    ...CREATIVE_STAGE_DEFAULTS,
    label: "剧本大纲",
    output_file: "3.1-outline.json",
    next_skill: "character_rewrite",
    execution_target: "剧本大纲创作",
    init_tool: "初始化剧本大纲"
  },
  character_rewrite: {
    ...CREATIVE_STAGE_DEFAULTS,
    label: "角色小传",
    output_file: "4.1-character.json",
    next_skill: "trial_generate",
    execution_target: "角色小传创作",
    init_tool: "初始化角色小传"
  },
  trial_generate: {
    ...CREATIVE_STAGE_DEFAULTS,
    label: "剧本试稿",
    output_file: "output/剧本试稿.md",
    next_skill: "full_generate",
    execution_target: "剧本试稿创作",
    init_tool: "初始化剧本试稿"
  },
  full_generate: {
    ...CREATIVE_STAGE_DEFAULTS,
    label: "剧本全稿",
    output_file: "output/完整剧本.md",
    next_skill: "dialogue_translate",
    execution_target: "剧本全稿创作",
    init_tool: "初始化剧本全稿"
  }
});

const CREATION_TASK_TYPES = new Set([
  "create",
  "creation",
  "new_script",
  "original",
  "original_creation",
  "script_creation"
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function strings(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => cleanText(item)).filter(Boolean);
}

function uniqueTexts(values) {
  const seen = new Set();
  return values.flatMap((value) => {
    const text = cleanText(value);
    const key = text.normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
    if (!text || seen.has(key)) return [];
    seen.add(key);
    return [text];
  });
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeJobId(value) {
  const result = cleanText(value);
  return /^[a-zA-Z0-9_-]+$/u.test(result) ? result : "";
}

function markdownText(value) {
  return cleanText(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}

function stageConfig(stage) {
  const config = STAGE_EXECUTION_CONFIG[stage];
  if (!config) throw new Error(`不支持生成执行策略的阶段：${stage}`);
  return config;
}

function stageOutputFile(workspaceDir, stage, outputFile = "") {
  const configured = cleanText(outputFile);
  if (configured) return path.resolve(workspaceDir, configured);
  return path.resolve(workspaceDir, stageConfig(stage).output_file);
}

function taskType(project) {
  return cleanText(project?.task_type) || "rewrite";
}

function taskLabel(project) {
  const labels = {
    rewrite: "剧本改写",
    novel: "小说改编",
    replicate: "爆款复刻",
    create: "新剧本创作",
    creation: "新剧本创作",
    new_script: "新剧本创作",
    original: "新剧本创作",
    original_creation: "新剧本创作",
    script_creation: "新剧本创作"
  };
  const value = taskType(project);
  return labels[value] || value;
}

function profile(project) {
  const brief = isObject(project?.distribution_brief) ? project.distribution_brief : {};
  return {
    theme: uniqueTexts(strings(brief.theme)),
    setting: uniqueTexts(strings(brief.setting)),
    background: uniqueTexts(strings(brief.background)),
    audience: uniqueTexts(strings(brief.audience))
  };
}

function profileTags(value) {
  return uniqueTexts([
    ...(value?.theme || []),
    ...(value?.setting || []),
    ...(value?.background || []),
    ...(value?.audience || [])
  ]).filter((item) => item !== "自动适配");
}

function unresolvedProfileFields(value) {
  return Object.entries(value).flatMap(([field, values]) => (
    !values.length || values.includes("自动适配") ? [field] : []
  ));
}

function explicitFormulaPolicy(project, stage) {
  const policy = project?.knowledge_policy?.[stage];
  if (!isObject(policy)) return null;
  for (const key of ["use_formulas", "formula_cards", "strategy_formulas"]) {
    if (typeof policy[key] === "boolean") return policy[key];
  }
  return null;
}

export function stageKnowledgePolicy(project, stage) {
  const config = stageConfig(stage);
  const currentTaskType = taskType(project);
  const explicit = explicitFormulaPolicy(project, stage);
  return {
    task_type: currentTaskType,
    task_label: taskLabel(project),
    use_formulas: explicit ?? (
      config.formula_policy === "creation_only"
        ? CREATION_TASK_TYPES.has(currentTaskType)
        : true
    )
  };
}

export function stageExecutionSpecPaths(workspace, stage, options = {}) {
  const workspaceDir = path.resolve(workspace);
  const jobId = safeJobId(options.jobId ?? process.env.ORCA_AGENT_JOB_ID);
  const directory = jobId
    ? path.join(workspaceDir, "runtime", "jobs", jobId, stage)
    : path.join(workspaceDir, "runtime", stage);
  return {
    directory,
    markdown: path.join(directory, "执行规范.md"),
    snapshot: path.join(directory, "execution-spec.json"),
    strategy_markdown: path.join(directory, "执行策略.md"),
    strategy_snapshot: path.join(directory, "execution-strategy.json"),
    job_id: jobId
  };
}

async function readJson(filePath, fallback) {
  return fs.readFile(filePath, "utf8").then(JSON.parse).catch(() => fallback);
}

function memoryPreferences(memory, stage) {
  const entries = memory?.preferences?.[stage];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => typeof entry === "string" ? strings(entry) : strings(entry?.content));
}

async function snapshotPreferences(stage, contextPath) {
  if (!contextPath) return [];
  const snapshot = await readJson(path.resolve(contextPath), null);
  if (!isObject(snapshot) || snapshot.stage !== stage || !Array.isArray(snapshot.effective_preferences)) return [];
  return snapshot.effective_preferences.flatMap((item) => strings(item?.content));
}

async function effectiveRequirements(workspaceDir, userInput, stage, options = {}) {
  const preferenceContextPath = cleanText(
    options.preferenceContextPath ?? process.env.ORCA_USER_PREFERENCE_CONTEXT_PATH
  );
  const [memory, snapshotValues] = await Promise.all([
    readJson(path.join(workspaceDir, "memory", "stage-preferences.json"), { preferences: {} }),
    snapshotPreferences(stage, preferenceContextPath)
  ]);
  const project = userInput.project || {};
  const requirements = uniqueTexts([
    ...strings(project.extra_requirements),
    ...strings(project.stage_preferences?.[stage]),
    ...memoryPreferences(memory, stage)
  ]);
  const requirementKeys = new Set(requirements.map((item) => item.normalize("NFKC").replace(/\s+/gu, " ")));
  const preferences = uniqueTexts(snapshotValues).filter(
    (item) => !requirementKeys.has(item.normalize("NFKC").replace(/\s+/gu, " "))
  );
  return {
    user_requirements: requirements,
    user_preferences: preferences,
    preference_state_fingerprint: sha256(JSON.stringify({
      memory: memory?.preferences?.[stage] || [],
      snapshot: snapshotValues
    }))
  };
}

function projectFacts(userInput) {
  const result = summarizeUserRequirements(userInput)["用户需求"] || {};
  const facts = { ...result };
  delete facts["用户额外要求"];
  return facts;
}

function projectFingerprint(userInput) {
  return sha256(JSON.stringify(userInput?.project || {}));
}

async function regionRequirements(project, stage) {
  const region = await resolveRegionRules(project.target_region, stage);
  const brief = isObject(project.distribution_brief) ? project.distribution_brief : {};
  return {
    target_region: region.key,
    target_country: cleanText(brief.target_countries?.[0]) || region.default_market,
    target_locale: normalizeLocale(brief.target_locale || project.target_language || region.default_locale),
    rules: uniqueTexts(region.rules)
  };
}

async function adaptationFacts(workspaceDir) {
  const context = await getAdaptationContext(workspaceDir);
  return {
    source_kind: cleanText(context.source_kind),
    source_file: cleanText(context.source_file),
    world_view_file: path.join(workspaceDir, "2.1-world-view.json"),
    world_view: context.world_view || {},
    context_file: context.task_type === "novel"
      ? path.join(workspaceDir, "2.1-novel-analysis.json")
      : path.join(workspaceDir, "2.1-world-view.json")
  };
}

async function resolveKnowledgeDbPath(options = {}) {
  const configured = cleanText(options.knowledgeDbPath ?? process.env.ORCA_SCRIPT_KNOWLEDGE_DB_PATH);
  const candidate = path.resolve(configured || defaultKnowledgeDbPath);
  const exists = await fs.access(candidate).then(() => true).catch(() => false);
  if (!exists && configured) throw new Error(`剧本知识库不可用：${candidate}`);
  return exists ? candidate : "";
}

function queryRows(dbPath, sql) {
  if (!dbPath) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function principleFromRow(row) {
  return {
    id: cleanText(row.id),
    title: cleanText(row.title),
    statement: cleanText(row.statement),
    applies_when: uniqueTexts(parseJson(row.applies_when_json, [])),
    fails_or_changes_when: uniqueTexts(parseJson(row.fails_or_changes_when_json, [])),
    review_criteria: uniqueTexts(parseJson(row.review_criteria_json, [])),
    version: Number(row.version) || 1
  };
}

function executionPrinciple(value) {
  if (!isObject(value)) return value;
  const { rationale: _rationale, ...principle } = value;
  return principle;
}

function assertCompletePrinciple(principle, stage) {
  if (!principle.id || !principle.title || !principle.statement) {
    throw new Error(`${stage}创作原则缺少名称或要求`);
  }
  if (!principle.applies_when.length || !principle.fails_or_changes_when.length || !principle.review_criteria.length) {
    throw new Error(`${stage}创作原则“${principle.title}”缺少适用条件、例外或通过标准`);
  }
}

function loadPrinciples(dbPath, stage) {
  const rows = queryRows(dbPath, `
    SELECT id, title, stages_json, statement, applies_when_json,
           fails_or_changes_when_json, review_criteria_json, skill_keys_json, version, source_count
    FROM script_library_principles
    WHERE status = 'active'
    ORDER BY source_count DESC, title
  `);
  return rows.flatMap((row) => {
    const stages = parseJson(row.stages_json, []);
    const skillKeys = parseJson(row.skill_keys_json, []);
    if (!stages.includes(stage) && !skillKeys.includes(`stage:${stage}`)) return [];
    const principle = principleFromRow(row);
    assertCompletePrinciple(principle, stage);
    return [principle];
  });
}

function formulaFromRow(row) {
  const content = parseJson(row.content_json, {});
  return {
    id: cleanText(row.id),
    name: cleanText(row.name),
    category: cleanText(row.category),
    stages: uniqueTexts(parseJson(row.stages_json, [])),
    applicable_tags: uniqueTexts(parseJson(row.applicable_tags_json, [])),
    usage_scenario: cleanText(content.usage_scenario || row.creative_decision || row.creative_problem),
    source_count: Number(row.source_count) || 0,
    revision: Number(row.revision) || 1,
    content
  };
}

function loadFormulas(dbPath, stage, tags) {
  if (!tags.length) return [];
  const tagSet = new Set(tags);
  return queryRows(dbPath, `
    SELECT id, category, name, stages_json, creative_decision, creative_problem,
           applicable_tags_json, source_count, revision, content_json
    FROM script_library_formulas
    WHERE status = 'active'
    ORDER BY source_count DESC, name
  `).flatMap((row) => {
    const formula = formulaFromRow(row);
    if (!formula.id || !formula.name || !formula.usage_scenario || !formula.stages.includes(stage)) return [];
    const matchedTags = formula.applicable_tags.filter((tag) => tagSet.has(tag));
    if (formula.applicable_tags.length && !matchedTags.length) return [];
    return [{ ...formula, matched_tags: matchedTags }];
  }).sort((left, right) => (
    right.matched_tags.length - left.matched_tags.length
    || right.source_count - left.source_count
    || left.name.localeCompare(right.name, "zh-CN")
  )).slice(0, 12);
}

function renderValue(value) {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== "object" || item === null)) return value.join("、");
    return value.map((item) => renderValue(item)).join("；");
  }
  if (isObject(value)) return Object.entries(value).map(([key, item]) => `${key}：${renderValue(item)}`).join("；");
  if (typeof value === "boolean") return value ? "是" : "否";
  return cleanText(value);
}

function renderFacts(facts) {
  const lines = Object.entries(facts).flatMap(([key, value]) => {
    const rendered = renderValue(value);
    return rendered ? [`- ${key}：${rendered}`] : [];
  });
  return lines.length ? lines.join("\n") : "- 本次任务没有其他已确定信息。";
}

function renderNumbered(values, emptyText) {
  return values.length ? values.map((item, index) => `${index + 1}. ${item}`).join("\n") : emptyText;
}

function renderPrinciples(principles, stage) {
  const label = stageConfig(stage).label;
  if (!principles.length) return `当前没有已启用的${label}创作原则；仍须执行 Skill 中的固定质量、格式与准出要求。`;
  return principles.map((principle, index) => `### ${index + 1}. ${principle.title}

- 原则要求：${principle.statement}
- 适用条件：
${principle.applies_when.map((item, itemIndex) => `  ${itemIndex + 1}. ${item}`).join("\n")}
- 例外与失效情况：
${principle.fails_or_changes_when.map((item, itemIndex) => `  ${itemIndex + 1}. ${item}`).join("\n")}
- 通过标准：
${principle.review_criteria.map((item, itemIndex) => `  ${itemIndex + 1}. ${item}`).join("\n")}`).join("\n\n");
}

function renderFormulaSection({ formulas, config }) {
  if (!formulas.length) return `## 策略公式\n\n当前标签没有匹配到已启用的${config.formula_label}。不要为了使用公式而扩大检索范围。`;
  const rows = formulas.map((formula) => (
    `| ${markdownText(formula.usage_scenario)} | ${markdownText(formula.name)} |`
  ));
  return `## 策略公式

| 使用场景 | 公式名称 |
| --- | --- |
${rows.join("\n")}`;
}

function renderExecutionSpec(snapshot, workspaceDir, stage) {
  const config = stageConfig(stage);
  const requirements = [
    ...snapshot.requirements.user_requirements.map((item) => `用户要求：${item}`),
    ...snapshot.requirements.user_preferences.map((item) => `用户偏好：${item}`),
    ...snapshot.requirements.region.rules.map((item) => `地区要求：${item}`)
  ];
  const adaptationSection = config.include_adaptation_context
    ? `\n\n## 改编上下文\n\n${renderFacts(snapshot.adaptation_context)}`
    : "";
  const scriptProfileSection = config.include_script_profile
    ? `\n\n## 剧本标签\n\n${renderFacts(snapshot.script_profile)}`
    : "";
  const executionContext = isObject(snapshot.execution_context)
    ? Object.entries(snapshot.execution_context).flatMap(([key, value]) => {
      const rendered = renderValue(value);
      return rendered ? [`- ${key}：${rendered}`] : [];
    })
    : [];
  const executionContextSection = executionContext.length ? `\n${executionContext.join("\n")}` : "";
  return `# 执行规范

本文件记录本次${config.label}任务已经确定的事实和要求。创作原则与策略公式以“执行策略”工具生成的文件为准。

## 初始化目录信息

- 项目目录：\`${workspaceDir}\`
- 当前阶段：${config.label}
- 当前输出文件：\`${snapshot.output_contract.file}\`
- 任务场景：${snapshot.policy.task_label}${executionContextSection}${adaptationSection}

## 执行要求

### 当前任务

${renderFacts(snapshot.facts)}

### 本阶段要求

${renderNumbered(requirements, config.empty_requirements)}${scriptProfileSection}
`;
}

function renderExecutionStrategy(snapshot, stage) {
  const config = stageConfig(stage);
  if (snapshot.knowledge_status !== "loaded") {
    return `# 执行策略

剧本标签尚未全部确定，本次不获取创作原则和策略公式。完成标签后，重新调用“执行策略”工具。\n`;
  }
  const instruction = snapshot.policy.use_formulas
    ? `请遵循\`执行原则\`，按需使用\`策略公式\`，完成${config.execution_target}。`
    : `请遵循\`执行原则\`完成${config.execution_target}。`;
  const formulaSection = snapshot.policy.use_formulas
    ? `\n\n${renderFormulaSection({ formulas: snapshot.formulas, config })}`
    : "";
  return `# 执行策略

${instruction}

## 执行原则

${renderPrinciples(snapshot.principles, stage)}${formulaSection}
`;
}

function reusableSnapshot(existing, paths, stage) {
  return Boolean(paths.job_id && isObject(existing) && existing.stage === stage && existing.job_id === paths.job_id);
}

function sameProfile(left, right) {
  return sha256(JSON.stringify(left || {})) === sha256(JSON.stringify(right || {}));
}

function outputContract(workspaceDir, stage, outputFile = "") {
  const config = stageConfig(stage);
  const file = stageOutputFile(workspaceDir, stage, outputFile);
  return { file, stage, next_skill: config.next_skill, ...(config.output_contract || {}) };
}

export async function writeStageExecutionSpec({ workspace, stage, userInput, outputFile, options = {} }) {
  const workspaceDir = path.resolve(workspace);
  const config = stageConfig(stage);
  const paths = stageExecutionSpecPaths(workspaceDir, stage, options);
  const existing = await readJson(paths.snapshot, null);
  const canReuse = reusableSnapshot(existing, paths, stage);
  const project = userInput.project || {};
  const [requirements, region, context] = await Promise.all([
    effectiveRequirements(workspaceDir, userInput, stage, options),
    regionRequirements(project, stage),
    config.include_adaptation_context ? adaptationFacts(workspaceDir) : Promise.resolve(null)
  ]);
  const scriptProfile = profile(project);
  const now = new Date().toISOString();
  const snapshot = {
    schema_version: "1.0.0",
    stage,
    job_id: paths.job_id,
    snapshot_created_at: canReuse ? existing.snapshot_created_at : now,
    refreshed_at: now,
    refresh_version: canReuse ? Number(existing.refresh_version || 1) + 1 : 1,
    project_fingerprint: projectFingerprint(userInput),
    preference_state_fingerprint: requirements.preference_state_fingerprint,
    policy: stageKnowledgePolicy(project, stage),
    execution_context: isObject(options.executionContext) ? options.executionContext : {},
    facts: projectFacts(userInput),
    requirements: { user_requirements: requirements.user_requirements, user_preferences: requirements.user_preferences, region },
    ...(context ? { adaptation_context: context } : {}),
    script_profile: scriptProfile,
    pending_script_profile_fields: pendingScriptProfileFields(project.distribution_brief),
    output_contract: outputContract(workspaceDir, stage, outputFile)
  };
  const markdown = renderExecutionSpec(snapshot, workspaceDir, stage);
  snapshot.markdown_sha256 = sha256(markdown);
  await fs.mkdir(paths.directory, { recursive: true });
  await Promise.all([
    fs.writeFile(paths.markdown, markdown, "utf8"),
    fs.writeFile(paths.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
  ]);
  return { paths, snapshot };
}

export async function writeStageExecutionStrategy({ workspace, stage, userInput, options = {} }) {
  const workspaceDir = path.resolve(workspace);
  stageConfig(stage);
  const paths = stageExecutionSpecPaths(workspaceDir, stage, options);
  const specIssues = await stageExecutionSpecIssues(workspaceDir, stage, userInput, options);
  if (specIssues.length) throw new Error(specIssues[0]);
  const [{ snapshot: executionSpec }, existing] = await Promise.all([
    loadStageExecutionSpec(workspaceDir, stage, options),
    readJson(paths.strategy_snapshot, null)
  ]);
  const canReuse = reusableSnapshot(existing, paths, stage);
  const project = userInput.project || {};
  const policy = stageKnowledgePolicy(project, stage);
  const scriptProfile = profile(project);
  const unresolvedFields = unresolvedProfileFields(scriptProfile);
  let principles = [];
  let formulas = [];
  if (!unresolvedFields.length) {
    const knowledgeDbPath = await resolveKnowledgeDbPath(options);
    principles = canReuse && existing.knowledge_status === "loaded"
      ? (Array.isArray(existing.principles) ? existing.principles.map(executionPrinciple) : [])
      : loadPrinciples(knowledgeDbPath, stage);
    principles.forEach((item) => assertCompletePrinciple(item, stage));
    const canReuseFormulas = Boolean(
      canReuse && existing.knowledge_status === "loaded" && policy.use_formulas
      && existing.formulas_resolved === true && sameProfile(existing.script_profile, scriptProfile)
    );
    formulas = !policy.use_formulas
      ? []
      : canReuseFormulas ? existing.formulas : loadFormulas(knowledgeDbPath, stage, profileTags(scriptProfile));
  }
  const now = new Date().toISOString();
  const snapshot = {
    schema_version: "1.0.0",
    stage,
    job_id: paths.job_id,
    snapshot_created_at: canReuse ? existing.snapshot_created_at : now,
    refreshed_at: now,
    refresh_version: canReuse ? Number(existing.refresh_version || 1) + 1 : 1,
    execution_spec_sha256: executionSpec.markdown_sha256,
    project_fingerprint: projectFingerprint(userInput),
    policy,
    script_profile: scriptProfile,
    unresolved_script_profile_fields: unresolvedFields,
    knowledge_status: unresolvedFields.length ? "skipped_unresolved_profile" : "loaded",
    principles,
    formulas,
    formulas_resolved: !unresolvedFields.length
  };
  const markdown = renderExecutionStrategy(snapshot, stage);
  snapshot.markdown_sha256 = sha256(markdown);
  await fs.mkdir(paths.directory, { recursive: true });
  await Promise.all([
    fs.writeFile(paths.strategy_markdown, markdown, "utf8"),
    fs.writeFile(paths.strategy_snapshot, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
  ]);
  return { paths, snapshot };
}

export async function loadStageExecutionSpec(workspace, stage, options = {}) {
  const paths = stageExecutionSpecPaths(workspace, stage, options);
  const [snapshot, markdown] = await Promise.all([
    readJson(paths.snapshot, null),
    fs.readFile(paths.markdown, "utf8").catch(() => "")
  ]);
  return { paths, snapshot, markdown };
}

export async function loadStageExecutionStrategy(workspace, stage, options = {}) {
  const paths = stageExecutionSpecPaths(workspace, stage, options);
  const [snapshot, markdown] = await Promise.all([
    readJson(paths.strategy_snapshot, null),
    fs.readFile(paths.strategy_markdown, "utf8").catch(() => "")
  ]);
  return { paths, snapshot, markdown };
}

export async function shouldValidateStageExecution(workspace, stage, options = {}) {
  const paths = stageExecutionSpecPaths(workspace, stage, options);
  if (paths.job_id) return true;
  const candidates = [paths.markdown, paths.snapshot, paths.strategy_markdown, paths.strategy_snapshot];
  const states = await Promise.all(candidates.map((filePath) => fs.access(filePath).then(() => true).catch(() => false)));
  return states.some(Boolean);
}

export async function stageExecutionSpecIssues(workspace, stage, userInput, options = {}) {
  const config = stageConfig(stage);
  const { snapshot, markdown } = await loadStageExecutionSpec(workspace, stage, options);
  const issues = [];
  if (!isObject(snapshot) || snapshot.stage !== stage) return [`${config.label}执行规范缺失或已失效，请重新调用“${config.init_tool}”`];
  if (!markdown || sha256(markdown) !== snapshot.markdown_sha256) issues.push(`执行规范已被修改，请重新调用“${config.init_tool}”`);
  if (snapshot.project_fingerprint !== projectFingerprint(userInput)) issues.push(`项目信息在初始化后发生了变化，请重新调用“${config.init_tool}”`);
  const requirements = await effectiveRequirements(path.resolve(workspace), userInput, stage, options);
  if (snapshot.preference_state_fingerprint !== requirements.preference_state_fingerprint) issues.push(`本阶段的用户要求或偏好在初始化后发生了变化，请重新调用“${config.init_tool}”`);
  return issues;
}

export async function stageExecutionStrategyIssues(workspace, stage, userInput, options = {}) {
  const specIssues = await stageExecutionSpecIssues(workspace, stage, userInput, options);
  if (specIssues.length) return specIssues;
  const [{ snapshot: executionSpec }, { snapshot, markdown }] = await Promise.all([
    loadStageExecutionSpec(workspace, stage, options),
    loadStageExecutionStrategy(workspace, stage, options)
  ]);
  const issues = [];
  if (!isObject(snapshot) || snapshot.stage !== stage) return ["执行策略缺失或已失效，请重新调用执行策略工具"];
  if (!markdown || sha256(markdown) !== snapshot.markdown_sha256) issues.push("执行策略已被修改，请重新调用执行策略工具");
  if (/- 成立原因：/u.test(markdown) || (snapshot.principles || []).some((item) => Object.hasOwn(item, "rationale"))) issues.push("执行策略包含仅用于解释的成立原因，请重新生成执行策略");
  if (snapshot.execution_spec_sha256 !== executionSpec.markdown_sha256) issues.push("执行规范在策略生成后发生了变化，请重新调用执行策略工具");
  if (snapshot.project_fingerprint !== projectFingerprint(userInput)) issues.push("项目信息在策略生成后发生了变化，请重新调用执行策略工具");
  if (!sameProfile(snapshot.script_profile, profile(userInput.project || {}))) issues.push("剧本标签在策略生成后发生了变化，请重新调用执行策略工具");
  const unresolvedFields = unresolvedProfileFields(profile(userInput.project || {}));
  if (unresolvedFields.length) {
    if (snapshot.knowledge_status !== "skipped_unresolved_profile") issues.push("剧本标签尚未确定，当前执行策略不应获取创作原则或策略公式");
    if ((snapshot.principles || []).length || (snapshot.formulas || []).length) issues.push("剧本标签尚未确定，请重新生成不含创作原则和策略公式的执行策略");
  } else {
    if (snapshot.knowledge_status !== "loaded") issues.push("执行策略没有获取当前标签对应的知识，请重新调用执行策略工具");
    if (snapshot.policy?.use_formulas && snapshot.formulas_resolved !== true) issues.push("当前阶段的策略公式尚未获取，请重新调用执行策略工具");
  }
  try {
    (snapshot.principles || []).forEach((item) => assertCompletePrinciple(item, stage));
  } catch (error) {
    issues.push(error.message);
  }
  return issues;
}

export function strategyFormulaPayload(snapshot, formulaName, stage) {
  if (!isObject(snapshot) || snapshot.stage !== stage) throw new Error("当前阶段执行策略不可用");
  if (snapshot.knowledge_status !== "loaded") throw new Error("剧本标签尚未确定，当前执行策略没有获取公式");
  if (!snapshot.policy?.use_formulas) throw new Error("当前任务场景不使用策略公式");
  const matches = (snapshot.formulas || []).filter((item) => item.name === formulaName);
  if (matches.length !== 1) throw new Error(matches.length ? "公式名称不唯一" : "当前执行策略中没有该公式");
  const formula = matches[0];
  const content = formula.content || {};
  const tags = new Set(profileTags(snapshot.script_profile || {}));
  const adaptations = Array.isArray(content.genre_adaptations)
    ? content.genre_adaptations.filter((item) => strings(item?.tags).some((tag) => tags.has(tag)))
    : [];
  const useOriginal = ["create", "creation", "new_script", "original"].includes(snapshot.policy.task_type);
  return {
    "公式名称": formula.name,
    "适用阶段": formula.stages,
    "使用场景": formula.usage_scenario,
    "不适用情况": content.not_applicable || [],
    "创作目标": cleanText(content.goal),
    "核心公式": cleanText(content.core_formula),
    "使用前确认": content.conditions || [],
    "可替换内容": content.variables || [],
    "使用方法": content.steps || [],
    "生效原因": cleanText(content.mechanism),
    "完成标准": content.observable_checks || [],
    "常见失效方式": content.failure_modes || [],
    "当前场景用法": cleanText(useOriginal ? content.original_usage : content.rewrite_usage),
    "当前标签差异": adaptations
  };
}
