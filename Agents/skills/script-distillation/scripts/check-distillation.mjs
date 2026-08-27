#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CREATIVE_STAGES,
  DEFAULT_TAXONOMY_PATH,
  FORMULA_CATEGORIES,
  loadTaxonomy,
  parseArgs,
  parseIndexedChunks,
  readJson,
  sourceContentHash
} from "./distillation-utils.mjs";

const OPTIONS = Object.freeze({
  "--source": "source",
  "--output": "output",
  "--taxonomy": "taxonomy",
  "--formula-catalog": "formulaCatalog",
  "--principle-catalog": "principleCatalog"
});

const FORMULA_ACTIONS = new Set(["unresolved", "reuse", "improve", "propose"]);
const PRINCIPLE_ACTIONS = new Set(["unresolved", "support", "improve", "counter", "propose"]);
const PRINCIPLE_RELATIONS = new Set(["supports", "bounds", "counters", "proposes"]);
const ERA_BACKGROUNDS = new Set(["现代", "古代", "年代", "民国"]);
const GENERIC_SOURCE_TERMS = new Set(["主角", "对手", "人物", "角色", "公司", "集团", "城市", "学校", "医院", "婚礼", "证据", "项目", "关系", "选择权", "真相", "家族", "团队"]);
const CREATIVE_STAGE_TEXT = CREATIVE_STAGES.join("、");

function objectValue(value, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} 必须是对象`);
    return {};
  }
  return value;
}

function textValue(value, label, errors, minimum = 1, maximum = 2400) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < minimum) errors.push(`${label} 至少需要 ${minimum} 个字符`);
  if (text.length > maximum) errors.push(`${label} 不能超过 ${maximum} 个字符`);
  return text;
}

function arrayValue(value, label, errors, minimum = 0, maximum = 20) {
  if (!Array.isArray(value)) {
    errors.push(`${label} 必须是数组`);
    return [];
  }
  if (value.length < minimum) errors.push(`${label} 至少需要 ${minimum} 项`);
  if (value.length > maximum) errors.push(`${label} 最多允许 ${maximum} 项`);
  return value.slice(0, maximum);
}

function stringArray(value, label, errors, { minimum = 0, maximum = 20, itemMinimum = 2 } = {}) {
  const values = arrayValue(value, label, errors, minimum, maximum);
  const normalized = [];
  for (const [index, item] of values.entries()) {
    const text = textValue(item, `${label}第 ${index + 1} 项`, errors, itemMinimum, 600);
    if (text && normalized.includes(text)) errors.push(`${label}存在重复项：${text}`);
    if (text && !normalized.includes(text)) normalized.push(text);
  }
  return normalized;
}

function evidenceReferences(value, label, errors, validIds, minimum = 1) {
  const references = stringArray(value, label, errors, { minimum, maximum: 24, itemMinimum: 5 });
  for (const reference of references) {
    if (!/^C\d{4,}$/u.test(reference) || !validIds.has(reference)) errors.push(`${label}引用了无效证据：${reference}`);
  }
  return references;
}

function hasFullCoverage(references, chunkCount) {
  const numbers = new Set(references.map((item) => Number(item.slice(1))).filter(Number.isInteger));
  if (chunkCount <= 2) return numbers.size >= chunkCount;
  const openingEnd = Math.max(1, Math.ceil(chunkCount / 4));
  const endingStart = Math.max(openingEnd + 2, Math.ceil(chunkCount * 3 / 4));
  return [...numbers].some((item) => item <= openingEnd)
    && [...numbers].some((item) => item > openingEnd && item < endingStart)
    && [...numbers].some((item) => item >= endingStart);
}

function recordIds(items, field, label, errors) {
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    const id = textValue(item?.[field], `${label}第 ${index + 1} 项的 ${field}`, errors, 3, 20);
    if (id && ids.has(id)) errors.push(`${label} ID 重复：${id}`);
    if (id) ids.add(id);
  }
  return ids;
}

function catalogIds(payload) {
  if (!payload) return new Set();
  const candidates = Array.isArray(payload)
    ? payload
    : [payload.items, payload.formulas, payload.principles, payload.cards, payload.mechanisms].find(Array.isArray) || [];
  return new Set(candidates.flatMap((item) => {
    const id = item && typeof item === "object"
      ? item.id || item.candidate_id || item.principle_id || item.mechanism_id
      : "";
    return String(id || "").trim() ? [String(id).trim()] : [];
  }));
}

async function optionalCatalog(filePath) {
  if (!filePath) return { provided: false, ids: new Set() };
  return { provided: true, ids: catalogIds(await readJson(path.resolve(filePath))) };
}

function validateCatalogDecision(decisionValue, { label, kind, catalog, errors }) {
  const decision = objectValue(decisionValue, `${label}.catalog_decision`, errors);
  const action = textValue(decision.action, `${label}.catalog_decision.action`, errors, 4, 20);
  const targetId = typeof decision.target_id === "string" ? decision.target_id.trim() : "";
  textValue(decision.reason, `${label}.catalog_decision.reason`, errors, 12, 600);
  if (action !== "unresolved") errors.push(`${label} 的 catalog_decision 只能填写 unresolved`);
  if (targetId) errors.push(`${label} 的 catalog_decision.target_id 必须为空`);
}

function includesForbiddenTerm(values, forbiddenTerms) {
  const content = values.flat().map((item) => String(item || "")).join("\n");
  return forbiddenTerms.find((term) => term.length >= 2 && content.includes(term));
}

export async function validateDistillation(args) {
  const errors = [];
  const sourcePath = path.resolve(args.source);
  const outputPath = path.resolve(args.output);
  const taxonomyPath = args.taxonomy ? path.resolve(args.taxonomy) : DEFAULT_TAXONOMY_PATH;
  const chunks = parseIndexedChunks(await fs.readFile(sourcePath, "utf8"));
  if (!chunks.length) throw new Error("蒸馏原文缺少 C0001 格式的证据索引");
  const validIds = new Set(chunks.map((item) => item.id));
  const sourceText = chunks.map((item) => item.content).join("\n\n");
  const taxonomy = await loadTaxonomy(taxonomyPath);
  const payload = objectValue(await readJson(outputPath), "蒸馏结果", errors);
  const formulaCatalog = await optionalCatalog(args.formulaCatalog);
  const principleCatalog = await optionalCatalog(args.principleCatalog);

  if (payload.schema_version !== "1.0.0") errors.push("schema_version 必须保持为 1.0.0");
  const source = objectValue(payload.source, "source", errors);
  textValue(source.title, "source.title", errors, 1, 160);
  if (source.content_sha256 !== sourceContentHash(chunks)) errors.push("source.content_sha256 与当前原文不一致");
  if (source.chunk_count !== chunks.length) errors.push("source.chunk_count 与当前证据块数量不一致");
  textValue(payload.summary, "summary", errors, 80, 1600);

  const tags = objectValue(payload.tags, "tags", errors);
  const normalizedTags = {};
  for (const [kind, limits] of Object.entries({ theme: [1, 3], setting: [1, 4], background: [1, 3], audience: [1, 1] })) {
    normalizedTags[kind] = stringArray(tags[kind], `tags.${kind}`, errors, { minimum: limits[0], maximum: limits[1], itemMinimum: 2 });
    for (const value of normalizedTags[kind]) {
      if (!taxonomy[kind].includes(value)) errors.push(`tags.${kind} 包含词表外标签：${value}`);
    }
  }
  const eras = normalizedTags.background.filter((item) => ERA_BACKGROUNDS.has(item));
  if (eras.length > 1) errors.push(`背景不能同时包含多个主要时代：${eras.join("、")}`);
  if (normalizedTags.theme.includes("现代言情") && normalizedTags.background.some((item) => ["古代", "宫廷", "年代", "民国"].includes(item))) {
    errors.push("现代言情与古代、宫廷、年代或民国主背景不一致");
  }
  if (normalizedTags.theme.includes("古风言情") && normalizedTags.background.some((item) => ["现代", "都市", "职场", "校园"].includes(item))) {
    errors.push("古风言情与现代、都市、职场或校园主背景不一致");
  }
  if (normalizedTags.theme.includes("年代爱情") && normalizedTags.background.some((item) => ["现代", "古代", "民国"].includes(item))) {
    errors.push("年代爱情与现代、古代或民国主背景不一致");
  }
  if (normalizedTags.theme.includes("民国爱情") && normalizedTags.background.some((item) => ["现代", "古代", "年代"].includes(item))) {
    errors.push("民国爱情与现代、古代或年代主背景不一致");
  }
  const allScriptTags = new Set(Object.values(normalizedTags).flat());

  const card = objectValue(payload.case_card, "case_card", errors);
  textValue(card.logline, "case_card.logline", errors, 30, 420);
  textValue(card.audience_promise, "case_card.audience_promise", errors, 24, 600);
  const engine = objectValue(card.story_engine, "case_card.story_engine", errors);
  for (const field of ["initial_situation", "protagonist_goal", "main_resistance", "stakes", "repeatable_conflict_loop", "ending_change"]) {
    textValue(engine[field], `case_card.story_engine.${field}`, errors, 16, 700);
  }

  const worldRules = arrayValue(card.world_rules, "case_card.world_rules", errors, 0, 6);
  for (const [index, itemValue] of worldRules.entries()) {
    const item = objectValue(itemValue, `世界规则 ${index + 1}`, errors);
    for (const field of ["rule", "resource_or_limit", "violation_cost", "story_function"]) {
      textValue(item[field], `世界规则 ${index + 1}.${field}`, errors, 10, 500);
    }
    evidenceReferences(item.evidence_references, `世界规则 ${index + 1} 的证据`, errors, validIds);
  }

  const characters = arrayValue(card.characters, "case_card.characters", errors, 2, 8);
  for (const [index, itemValue] of characters.entries()) {
    const item = objectValue(itemValue, `人物 ${index + 1}`, errors);
    textValue(item.name, `人物 ${index + 1}.name`, errors, 1, 40);
    for (const field of ["dramatic_function", "desire", "fear_need_or_misbelief", "leverage", "secret_or_unknown", "initial_state", "turning_action", "final_state"]) {
      textValue(item[field], `人物 ${index + 1}.${field}`, errors, field === "turning_action" ? 12 : 8, 600);
    }
    evidenceReferences(item.evidence_references, `人物 ${index + 1} 的证据`, errors, validIds);
  }

  const relationships = arrayValue(card.relationship_dynamics, "case_card.relationship_dynamics", errors, 1, 8);
  for (const [index, itemValue] of relationships.entries()) {
    const item = objectValue(itemValue, `关系 ${index + 1}`, errors);
    stringArray(item.parties, `关系 ${index + 1}.parties`, errors, { minimum: 2, maximum: 4, itemMinimum: 1 });
    for (const field of ["initial_power", "debt_or_misunderstanding", "change_chain", "final_state"]) {
      textValue(item[field], `关系 ${index + 1}.${field}`, errors, 12, 700);
    }
    evidenceReferences(item.evidence_references, `关系 ${index + 1} 的证据`, errors, validIds);
  }

  const phases = arrayValue(card.narrative_phases, "case_card.narrative_phases", errors, 3, 8);
  for (const [index, itemValue] of phases.entries()) {
    const item = objectValue(itemValue, `叙事阶段 ${index + 1}`, errors);
    textValue(item.phase, `叙事阶段 ${index + 1}.phase`, errors, 2, 40);
    for (const field of ["goal", "opposition", "irreversible_change", "audience_return"]) {
      textValue(item[field], `叙事阶段 ${index + 1}.${field}`, errors, 12, 700);
    }
    evidenceReferences(item.evidence_references, `叙事阶段 ${index + 1} 的证据`, errors, validIds);
  }

  const payoffs = arrayValue(card.audience_payoffs, "case_card.audience_payoffs", errors, 2, 8);
  for (const [index, itemValue] of payoffs.entries()) {
    const item = objectValue(itemValue, `观众体验 ${index + 1}`, errors);
    textValue(item.payoff_type, `观众体验 ${index + 1}.payoff_type`, errors, 1, 40);
    for (const field of ["setup", "pressure", "release", "story_consequence"]) {
      textValue(item[field], `观众体验 ${index + 1}.${field}`, errors, 10, 600);
    }
    evidenceReferences(item.evidence_references, `观众体验 ${index + 1} 的证据`, errors, validIds);
  }

  const observations = arrayValue(card.key_observations, "case_card.key_observations", errors, 3, 10);
  const observationIds = recordIds(observations, "observation_id", "关键观察", errors);
  const observationEvidence = new Map();
  for (const [index, itemValue] of observations.entries()) {
    const item = objectValue(itemValue, `关键观察 ${index + 1}`, errors);
    const id = String(item.observation_id || "").trim();
    if (!/^O\d{2,}$/u.test(id)) errors.push(`关键观察 ${index + 1} 的 ID 应使用 O01 格式`);
    if (!CREATIVE_STAGES.includes(item.stage)) errors.push(`关键观察 ${id || index + 1} 的 stage 无效：${item.stage || "空值"}。只能使用：${CREATIVE_STAGE_TEXT}；公式分类不能填在这里`);
    for (const field of ["creative_problem", "setup", "author_choice", "story_change", "audience_effect_hypothesis", "tradeoff_or_boundary"]) {
      textValue(item[field], `关键观察 ${id || index + 1}.${field}`, errors, 16, 800);
    }
    observationEvidence.set(id, new Set(evidenceReferences(item.evidence_references, `关键观察 ${id || index + 1} 的证据`, errors, validIds)));
  }

  stringArray(card.strengths, "case_card.strengths", errors, { minimum: 1, maximum: 8, itemMinimum: 8 });
  stringArray(card.limitations, "case_card.limitations", errors, { minimum: 1, maximum: 8, itemMinimum: 8 });
  const sourceTerms = stringArray(card.source_specific_terms, "case_card.source_specific_terms", errors, {
    minimum: sourceText.replace(/\s/gu, "").length >= 1000 ? 4 : 1,
    maximum: 16,
    itemMinimum: 2
  });
  for (const term of sourceTerms) {
    if (!sourceText.includes(term)) errors.push(`原文中无法回查专属词：${term}`);
  }
  const cardEvidence = evidenceReferences(
    card.evidence_references,
    "case_card.evidence_references",
    errors,
    validIds,
    Math.min(5, chunks.length)
  );
  if (!hasFullCoverage(cardEvidence, chunks.length)) errors.push("案例卡证据必须覆盖开篇、中段和收束");

  const formulas = arrayValue(payload.formula_candidates, "formula_candidates", errors, 0, 8);
  const formulaIds = recordIds(formulas, "candidate_id", "公式候选", errors);
  for (const [index, itemValue] of formulas.entries()) {
    const item = objectValue(itemValue, `公式候选 ${index + 1}`, errors);
    const id = String(item.candidate_id || "").trim();
    const label = `公式候选 ${id || index + 1}`;
    if (!/^F\d{2,}$/u.test(id)) errors.push(`${label} 的 ID 应使用 F01 格式`);
    if (!FORMULA_CATEGORIES.includes(item.category)) errors.push(`${label} 的 category 无效`);
    textValue(item.name, `${label}.name`, errors, 4, 80);
    const stages = stringArray(item.stages, `${label}.stages`, errors, { minimum: 1, maximum: 2, itemMinimum: 4 });
    for (const stage of stages) if (!CREATIVE_STAGES.includes(stage) || stage === "global") errors.push(`${label} 使用了无效创作阶段：${stage}。公式不得使用 global，公式分类也不能填在 stages`);
    if (stages.length > 1 && !(stages.includes("trial_generate") && stages.includes("full_generate"))) errors.push(`${label} 横跨了不同创作粒度`);
    const usageScenario = textValue(item.usage_scenario, `${label}.usage_scenario`, errors, 16, 300);
    if (/[?？]/u.test(usageScenario)) errors.push(`${label}.usage_scenario 应说明任务和目标变化，不能写成问题`);
    stringArray(item.not_applicable, `${label}.not_applicable`, errors, { minimum: 1, maximum: 6, itemMinimum: 6 });
    const decision = textValue(item.creative_decision, `${label}.creative_decision`, errors, 16, 300);
    const problem = textValue(item.creative_problem, `${label}.creative_problem`, errors, 16, 600);
    if (decision !== usageScenario || problem !== usageScenario) errors.push(`${label} 的 creative_decision 和 creative_problem 必须与 usage_scenario 完全一致`);
    const goal = textValue(item.goal, `${label}.goal`, errors, 16, 600);
    const coreFormula = textValue(item.core_formula, `${label}.core_formula`, errors, 16, 800);
    const conditions = stringArray(item.conditions, `${label}.conditions`, errors, { minimum: 1, maximum: 6, itemMinimum: 6 });
    const variables = stringArray(item.variables, `${label}.variables`, errors, { minimum: 2, maximum: 10, itemMinimum: 2 });
    const steps = stringArray(item.steps, `${label}.steps`, errors, { minimum: 2, maximum: 8, itemMinimum: 6 });
    const mechanism = textValue(item.mechanism, `${label}.mechanism`, errors, 24, 800);
    const expectedEffect = textValue(item.expected_effect, `${label}.expected_effect`, errors, 16, 600);
    if (expectedEffect !== goal) errors.push(`${label}.expected_effect 必须与 goal 完全一致`);
    const checks = stringArray(item.observable_checks, `${label}.observable_checks`, errors, { minimum: 1, maximum: 6, itemMinimum: 6 });
    const failures = stringArray(item.failure_modes, `${label}.failure_modes`, errors, { minimum: 1, maximum: 6, itemMinimum: 6 });
    const rewriteUsage = textValue(item.rewrite_usage, `${label}.rewrite_usage`, errors, 24, 800);
    const originalUsage = textValue(item.original_usage, `${label}.original_usage`, errors, 24, 800);
    const adaptations = arrayValue(item.genre_adaptations, `${label}.genre_adaptations`, errors, 1, 6);
    const adaptationText = [];
    for (const [adaptationIndex, adaptationValue] of adaptations.entries()) {
      const adaptation = objectValue(adaptationValue, `${label} 题材适配 ${adaptationIndex + 1}`, errors);
      const adaptationTags = stringArray(adaptation.tags, `${label} 题材适配 ${adaptationIndex + 1}.tags`, errors, { minimum: 1, maximum: 8, itemMinimum: 2 });
      for (const tag of adaptationTags) if (!allScriptTags.has(tag)) errors.push(`${label} 的题材适配使用了本剧之外的标签：${tag}`);
      adaptationText.push(
        textValue(adaptation.difference, `${label} 题材适配 ${adaptationIndex + 1}.difference`, errors, 8, 600),
        textValue(adaptation.usage_adjustment, `${label} 题材适配 ${adaptationIndex + 1}.usage_adjustment`, errors, 8, 600),
        textValue(adaptation.boundary_adjustment, `${label} 题材适配 ${adaptationIndex + 1}.boundary_adjustment`, errors, 8, 600)
      );
    }
    const applicableTags = stringArray(item.applicable_tags, `${label}.applicable_tags`, errors, { minimum: 1, maximum: 8, itemMinimum: 2 });
    for (const tag of applicableTags) if (!allScriptTags.has(tag)) errors.push(`${label} 使用了本剧之外的适用标签：${tag}`);
    const linkedObservations = stringArray(item.observation_refs, `${label}.observation_refs`, errors, { minimum: 1, maximum: 10, itemMinimum: 3 });
    for (const ref of linkedObservations) if (!observationIds.has(ref)) errors.push(`${label} 引用了不存在的观察：${ref}`);
    const formulaEvidence = evidenceReferences(item.evidence_references, `${label} 的证据`, errors, validIds);
    const linkedEvidence = new Set(linkedObservations.flatMap((ref) => [...(observationEvidence.get(ref) || [])]));
    if (!formulaEvidence.some((reference) => linkedEvidence.has(reference))) errors.push(`${label} 的证据与所关联观察没有交集`);
    const forbidden = includesForbiddenTerm([
      item.name,
      usageScenario,
      item.not_applicable,
      item.creative_problem,
      coreFormula,
      conditions,
      variables,
      steps,
      mechanism,
      expectedEffect,
      checks,
      failures,
      rewriteUsage,
      originalUsage,
      adaptationText
    ], sourceTerms.filter((term) => !GENERIC_SOURCE_TERMS.has(term)));
    if (forbidden) errors.push(`${label} 仍包含原文专属词：${forbidden}`);
    if (item.maturity !== "single_case") errors.push(`${label}.maturity 必须保持为 single_case`);
    validateCatalogDecision(item.catalog_decision, { label, kind: "formula", catalog: formulaCatalog, errors });
  }
  if (!formulas.length) textValue(payload.no_formula_reason, "no_formula_reason", errors, 20, 600);

  const principles = arrayValue(payload.principle_observations, "principle_observations", errors, 0, 6);
  recordIds(principles, "observation_id", "原则观察", errors);
  for (const [index, itemValue] of principles.entries()) {
    const item = objectValue(itemValue, `原则观察 ${index + 1}`, errors);
    const id = String(item.observation_id || "").trim();
    const label = `原则观察 ${id || index + 1}`;
    if (!/^P\d{2,}$/u.test(id)) errors.push(`${label} 的 ID 应使用 P01 格式`);
    const stages = stringArray(item.stages, `${label}.stages`, errors, { minimum: 1, maximum: 4, itemMinimum: 4 });
    for (const stage of stages) if (!CREATIVE_STAGES.includes(stage)) errors.push(`${label} 使用了无效创作阶段：${stage}。只能使用：${CREATIVE_STAGE_TEXT}；公式分类不能填在 stages`);
    const statement = textValue(item.statement, `${label}.statement`, errors, 20, 500);
    if (!PRINCIPLE_RELATIONS.has(item.relation)) errors.push(`${label}.relation 无效`);
    const rationale = textValue(item.rationale, `${label}.rationale`, errors, 20, 700);
    const applies = stringArray(item.applies_when, `${label}.applies_when`, errors, { minimum: 1, maximum: 6, itemMinimum: 8 });
    const boundaries = stringArray(item.fails_or_changes_when, `${label}.fails_or_changes_when`, errors, { minimum: 1, maximum: 6, itemMinimum: 8 });
    const criteria = stringArray(item.review_criteria, `${label}.review_criteria`, errors, { minimum: 1, maximum: 6, itemMinimum: 8 });
    const relatedFormulas = stringArray(item.related_formula_candidate_ids, `${label}.related_formula_candidate_ids`, errors, { minimum: 0, maximum: 8, itemMinimum: 3 });
    for (const formulaId of relatedFormulas) if (!formulaIds.has(formulaId)) errors.push(`${label} 引用了不存在的公式候选：${formulaId}`);
    evidenceReferences(item.evidence_references, `${label} 的证据`, errors, validIds);
    const forbidden = includesForbiddenTerm([statement, rationale, applies, boundaries, criteria], sourceTerms.filter((term) => !GENERIC_SOURCE_TERMS.has(term)));
    if (forbidden) errors.push(`${label} 仍包含原文专属词：${forbidden}`);
    if (item.status !== "candidate_only") errors.push(`${label}.status 必须保持为 candidate_only`);
    validateCatalogDecision(item.catalog_decision, { label, kind: "principle", catalog: principleCatalog, errors });
  }
  if (!principles.length) textValue(payload.no_principle_reason, "no_principle_reason", errors, 20, 600);

  const review = objectValue(payload.quality_review, "quality_review", errors);
  for (const field of ["full_source_read", "facts_and_hypotheses_separated", "formula_deidentified", "principles_kept_as_candidates"]) {
    if (review[field] !== true) errors.push(`quality_review.${field} 必须在完成对应检查后设为 true`);
  }
  stringArray(review.known_unknowns, "quality_review.known_unknowns", errors, { minimum: 0, maximum: 8, itemMinimum: 6 });

  if (errors.length) {
    const shown = errors.slice(0, 20);
    throw new Error(`${shown.join("；")}。${errors.length > shown.length ? `另有 ${errors.length - shown.length} 项问题。` : ""}`);
  }
  return {
    output: outputPath,
    title: source.title,
    chunks: chunks.length,
    observations: observations.length,
    formula_candidates: formulas.length,
    principle_observations: principles.length
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateDistillation(parseArgs(process.argv.slice(2), OPTIONS, ["source", "output"]))
    .then((result) => process.stdout.write(`${JSON.stringify({
      ok: true,
      message: "单剧蒸馏检查通过。",
      next_action: "结束本 Skill。由后续流程判断公式是直接复用、补充还是新增，并审核原则候选是否可以进入公共知识库。",
      ...result
    }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        tool: "检查单剧蒸馏",
        message: error.message,
        next_action: "只修复上面列出的问题：补全或修正字段，更正原文证据编号，删除公式中的原剧专名，或缩小原则声称的适用范围。修复后重新检查。"
      }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
