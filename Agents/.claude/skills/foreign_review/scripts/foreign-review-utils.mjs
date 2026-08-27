import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMaturityTarget, resolveTargetEpisodeCount } from "../../../tools/distribution-brief.mjs";
import { dialogueTranslationRelativePath, fullScriptRelativePath } from "../../../tools/script-artifacts.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const BASE_GRADES = Object.freeze(["D", "C", "B", "A", "S", "SS"]);

export const SCORECARD_SCHEMA_VERSION = "2.9.0";
export const REVIEW_SCORING_SCHEMA_VERSION = "1.0.0";
export const REVIEW_SCORING_RELATIVE_PATH = "runtime/review-scoring.json";
export const SCORING_TABLE_PATH = path.join(scriptDirectory, "../references/评分表.json5");
export const REVIEW_METHOD_TEMPLATE = [
  "本报告按以下顺序评估：",
  "",
  "1. **全文与准入：** 先确认集数、逐集内容量和终稿洁净度，排除尚不具备评级条件的交付问题。",
  "2. **故事与留存：** 从标题是否兑现、首集能否抓住观众，到主线因果、人物关系和单集悬念是否接续，判断观众为什么会点开并继续追看。",
  "3. **成片与制作：** 复核台词、画面、资产和连续性是否能落到 AI 成片，识别需要提前拆分的高复杂段落。",
  "4. **发行与风险：** 判断全剧是否具备持续观看和传播的理由，并检查内容尺度与价值后果。",
  "5. **评级与返修：** 汇总六维判断，确定总体评级、必须先解决的问题和后续处理顺序。"
].join("\n");
export const GRADES = BASE_GRADES;
export const ADMISSION_RESULTS = Object.freeze(["通过", "部分通过", "不通过"]);
export const ADMISSION_CHECKS = Object.freeze([
  "集数达标",
  "内容密度",
  "终稿洁净度",
  "标题承诺兑现",
  "主角能力有来源",
  "世界规则自洽",
  "角色关系成立",
  "爽点持续升级",
  "台词可执行",
  "视听与AI生产"
]);

export const VERDICTS = Object.freeze(["通过", "返修", "淘汰/重选", "补材料"]);
export const DIMENSION_RESULTS = Object.freeze(["通过", "可改进", "不通过"]);
export const REPAIR_SCOPES = Object.freeze([
  "项目要求/选品",
  "剧本大纲",
  "人物与关系",
  "剧本前段",
  "剧本全稿",
  "成片与制作",
  "海外发行复核",
  "补充材料"
]);

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isScore(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function roundScore(value) {
  return Math.round(value * 100) / 100;
}

function scoreTableError(message) {
  throw new Error(`评分表配置错误：${message}`);
}

function validateScoringTable(table) {
  if (!isPlainObject(table)) scoreTableError("根节点必须是对象");
  if (table.schema_version !== "1.1.0") scoreTableError("schema_version 必须为 1.1.0");
  if (!hasExactKeys(table["满分"], ["检查项", "维度", "总分"]) || Object.values(table["满分"]).some((value) => value !== 100)) {
    scoreTableError("检查项、维度和总分必须均为 100 分满分");
  }
  if (!Array.isArray(table["评级区间"]) || table["评级区间"].length !== BASE_GRADES.length) {
    scoreTableError("评级区间必须完整定义六档评级");
  }
  const expectedThresholds = { SS: 98, S: 90, A: 80, B: 70, C: 60, D: 0 };
  const ranges = table["评级区间"];
  if (ranges.some((item) => !isPlainObject(item) || !BASE_GRADES.includes(item["评级"]) || item["最低分"] !== expectedThresholds[item["评级"]])) {
    scoreTableError("评级区间必须使用 SS 98、S 90、A 80、B 70、C 60、D 0 的阈值");
  }
  if (new Set(ranges.map((item) => item["评级"])).size !== BASE_GRADES.length) scoreTableError("评级区间不能重复");
  if (!isPlainObject(table["总体评级微调"]) || table["总体评级微调"]["规则"] !== "所属评级区间上三分之一加号") {
    scoreTableError("总体评级微调规则必须为所属评级区间上三分之一加号");
  }
  if (!Array.isArray(table["总体评级微调"]["不使用加号的评级"]) || !table["总体评级微调"]["不使用加号的评级"].includes("SS")) {
    scoreTableError("总体评级微调必须将 SS 排除在加号之外");
  }
  const dimensions = table["维度"];
  if (!Array.isArray(dimensions) || dimensions.length !== 6) scoreTableError("必须定义六个分析维度");
  if (dimensions.some((dimension) => !isPlainObject(dimension) || !isText(dimension["名称"]) || !Number.isFinite(dimension["权重"]) || !Array.isArray(dimension["检查项"]))) {
    scoreTableError("每个维度都必须定义名称、权重和检查项");
  }
  if (new Set(dimensions.map((dimension) => dimension["名称"])).size !== dimensions.length) scoreTableError("维度名称不能重复");
  if (dimensions.reduce((total, dimension) => total + dimension["权重"], 0) !== 100) scoreTableError("维度权重之和必须为 100%");
  dimensions.forEach((dimension) => {
    const checks = dimension["检查项"];
    if (!checks.length || checks.some((check) => !isPlainObject(check) || !isText(check["名称"]) || !Number.isFinite(check["权重"]))) {
      scoreTableError(`“${dimension["名称"]}”的检查项必须定义名称和权重`);
    }
    if (new Set(checks.map((check) => check["名称"])).size !== checks.length) scoreTableError(`“${dimension["名称"]}”的检查项不能重复`);
    if (checks.reduce((total, check) => total + check["权重"], 0) !== 100) scoreTableError(`“${dimension["名称"]}”的检查项权重之和必须为 100%`);
  });
  return table;
}

const scoringTableText = await fs.readFile(SCORING_TABLE_PATH, "utf8");
export const SCORING_TABLE = Object.freeze(validateScoringTable(parseJson5(scoringTableText)));
export const SCORING_TABLE_HASH = hashText(scoringTableText);
export const DIMENSIONS = Object.freeze(SCORING_TABLE["维度"].map((dimension) => dimension["名称"]));
export const REQUIRED_CHECKS = Object.freeze(Object.fromEntries(
  SCORING_TABLE["维度"].map((dimension) => [dimension["名称"], Object.freeze(dimension["检查项"].map((check) => check["名称"]))])
));

export function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function hashFile(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseJson5(text) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gmu, ""));
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function normalizeLines(text) {
  return String(text).replace(/\r\n?/gu, "\n").replace(/\s+$/u, "").split("\n");
}

export function workspaceRelativePath(workspace, filePath) {
  return path.relative(workspace, filePath).split(path.sep).join("/");
}

function optionalText(value) {
  return isText(value) ? value.trim() : "未提供";
}

function optionalList(value) {
  return Array.isArray(value) ? value.filter(isText).map((item) => item.trim()) : [];
}

async function readOptionalJson(filePath) {
  return fs.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
}

async function existingFile(filePath) {
  return (await fs.stat(filePath).catch(() => null))?.isFile() ? filePath : "";
}

export async function resolveProjectReviewContext(workspace) {
  const userInput = await readOptionalJson(path.join(workspace, "1.1-user-input.json"));
  if (!isPlainObject(userInput) || !isPlainObject(userInput.project)) return null;
  const progress = await readOptionalJson(path.join(workspace, "1.2-project-progress.json"));
  const project = userInput.project;
  return {
    userInput,
    project,
    progress: isPlainObject(progress) ? progress : null,
    reviewOnly: project.task_type === "review"
  };
}

export async function resolveReviewInput(workspace) {
  const standalonePath = path.join(workspace, "review-input.json");
  const standalone = await readOptionalJson(standalonePath);
  if (isPlainObject(standalone)) {
    if (!isText(standalone.script_path)) throw new Error("review-input.json 缺少 script_path");
    const scriptPath = path.resolve(workspace, standalone.script_path);
    if (!await existingFile(scriptPath)) throw new Error(`待审剧本文本不存在：${standalone.script_path}`);
    const sourcePath = isText(standalone.source_path) ? path.resolve(workspace, standalone.source_path) : "";
    return {
      mode: standalone.review_mode === "rewrite" ? "剧本改写审稿" : "独立剧本审核",
      scriptPath,
      scriptRelativePath: workspaceRelativePath(workspace, scriptPath),
      sourcePath: await existingFile(sourcePath),
      sourceRelativePath: sourcePath && path.isAbsolute(standalone.source_path || "") ? standalone.source_path : String(standalone.source_path || ""),
      title: optionalText(standalone.script_title),
      scriptVersion: optionalText(standalone.script_version),
      targetMarket: optionalText(standalone.target_market),
      targetRegion: "未提供",
      targetLocale: optionalText(standalone.target_locale),
      episodeDuration: optionalText(standalone.episode_duration),
      targetEpisodeCount: resolveTargetEpisodeCount(standalone),
      maturityTarget: resolveMaturityTarget(standalone.maturity_target),
      userRequirements: optionalText(standalone.user_requirements),
      upstreamFiles: []
    };
  }

  const context = await resolveProjectReviewContext(workspace);
  if (!context) throw new Error("未找到 review-input.json，且当前项目缺少 1.1-user-input.json");

  const { project, reviewOnly } = context;
  const outline = await readOptionalJson(path.join(workspace, "3.1-outline.json"));
  const dialogueRelativePath = dialogueTranslationRelativePath(outline, { project });
  const fullRelativePath = fullScriptRelativePath(outline);
  const dialogueProgress = context.progress?.stages?.dialogue_translate;
  const scriptRelativePath = !reviewOnly && dialogueProgress?.status === "completed"
    && await existingFile(path.join(workspace, dialogueRelativePath))
    ? dialogueRelativePath
    : fullRelativePath;
  const scriptPath = path.resolve(workspace, scriptRelativePath);
  if (!await existingFile(scriptPath)) throw new Error(`待审剧本文本不存在：${scriptRelativePath}`);

  const brief = isPlainObject(project.distribution_brief) ? project.distribution_brief : {};
  const source = isPlainObject(project.source_script) ? project.source_script : {};
  const sourceRelativePath = project.task_type === "replicate"
    ? "output/爆款分析报告.md"
    : (isText(source.reference_path) ? source.reference_path.trim() : "");
  const sourcePath = sourceRelativePath ? await existingFile(path.resolve(workspace, sourceRelativePath)) : "";
  const upstreamFiles = [];
  if (!reviewOnly) {
    const upstreamCandidates = [
      project.task_type === "novel" ? "2.1-novel-analysis.json" : "2.1-world-view.json",
      ...(project.task_type === "replicate" ? ["output/爆款分析报告.md"] : []),
      "3.1-outline.json",
      "4.1-character.json"
    ];
    for (const fileName of upstreamCandidates) {
      if (await existingFile(path.join(workspace, fileName))) upstreamFiles.push(fileName);
    }
  }
  const countries = optionalList(brief.target_countries);
  return {
    mode: reviewOnly ? "独立剧本审核" : project.task_type === "novel" ? "小说改编审稿" : project.task_type === "replicate" ? "爆款复刻审稿" : "剧本改写审稿",
    scriptPath,
    scriptRelativePath,
    sourcePath,
    sourceRelativePath,
    title: optionalText(project.project_name || source.display_name),
    scriptVersion: reviewOnly ? "当前待审版本" : (scriptRelativePath === dialogueRelativePath ? "当前台词译稿" : "当前项目全稿"),
    targetMarket: countries[0] || optionalText(project.target_region),
    targetRegion: optionalText(project.target_region),
    targetLocale: optionalText(brief.target_locale),
    episodeDuration: optionalText(brief.episode_duration),
    targetEpisodeCount: resolveTargetEpisodeCount(brief),
    maturityTarget: resolveMaturityTarget(brief),
    userRequirements: optionalText(project.extra_requirements),
    upstreamFiles
  };
}

export function reviewScopeFromIndex(index) {
  const episodes = index.units.filter((unit) => unit.type === "剧集");
  if (index.structure_status === "规范分集" && episodes.length) {
    const first = episodes[0].episode;
    const last = episodes.at(-1).episode;
    return `全剧第 ${first}-${last} 集（共 ${episodes.length} 集）`;
  }
  if (index.structure_status === "候选结构") return `全文；仅识别到 ${index.units.length} 个候选审读单元，集数需人工核对`;
  return `全文；未识别稳定分集，按 ${index.units.length} 个正文区块审读`;
}

function sortedGradeRanges() {
  return [...SCORING_TABLE["评级区间"]].sort((left, right) => right["最低分"] - left["最低分"]);
}

function gradeRange(grade) {
  const normalized = baseGrade(grade);
  return sortedGradeRanges().find((item) => item["评级"] === normalized) || null;
}

function upperBoundForGrade(grade) {
  const ranges = sortedGradeRanges();
  const index = ranges.findIndex((item) => item["评级"] === baseGrade(grade));
  return index <= 0 ? 100 : ranges[index - 1]["最低分"];
}

export function baseGrade(grade) {
  return typeof grade === "string" ? grade.replace(/[+-]$/u, "") : "";
}

export function isOverallGrade(grade) {
  const normalized = baseGrade(grade);
  if (!GRADES.includes(normalized)) return false;
  if (grade === normalized) return true;
  return normalized !== "SS" && grade === `${normalized}+`;
}

export function gradeForScore(score) {
  if (!isScore(score)) return "";
  return sortedGradeRanges().find((item) => score >= item["最低分"])?.["评级"] || "";
}

export function overallGradeForScore(score) {
  const grade = gradeForScore(score);
  if (!grade || SCORING_TABLE["总体评级微调"]["不使用加号的评级"].includes(grade)) return grade;
  const range = gradeRange(grade);
  const upperBound = upperBoundForGrade(grade);
  const span = upperBound - range["最低分"];
  if (score >= range["最低分"] + span * 2 / 3) return `${grade}+`;
  return grade;
}

export function admissionConclusionForItems(items) {
  if (!Array.isArray(items) || items.length !== ADMISSION_CHECKS.length) return "";
  const results = items.map((item) => item?.["结果"]);
  if (results.some((result) => !ADMISSION_RESULTS.includes(result))) return "";
  if (results.includes("不通过")) return "不通过";
  return results.includes("部分通过") ? "部分通过" : "通过";
}

export function admissionAllowsScoring(scorecard) {
  const admission = scorecard?.["准入标准"];
  return isPlainObject(admission)
    && admissionConclusionForItems(admission["检查项"]) === admission["结论"]
    && ["通过", "部分通过"].includes(admission["结论"]);
}

export function createAdmissionGate() {
  return {
    "结论": "",
    "一句话判断": "",
    "检查项": ADMISSION_CHECKS.map((name) => ({
      "检查项": name,
      "结果": "",
      "说明": "",
      "原稿证据": []
    })),
    "修改建议": []
  };
}

export function scoreMidpointForGrade(grade) {
  const range = gradeRange(grade);
  if (!range) return null;
  return roundScore((range["最低分"] + upperBoundForGrade(grade)) / 2);
}

export function reviewResultForGrade(grade) {
  const normalized = baseGrade(grade);
  if (["A", "S", "SS"].includes(normalized)) return "通过";
  if (["B", "C"].includes(normalized)) return "可改进";
  return "不通过";
}

export function createScorecardDimensions() {
  return SCORING_TABLE["维度"].map((dimension) => ({
    "维度": dimension["名称"],
    "评级": "",
    "判断": "",
    "检查项": dimension["检查项"].map((check) => ({
      "检查项": check["名称"],
      "评级": "",
      "问题说明": "",
      "原稿证据": []
    }))
  }));
}

function scorecardDimension(card, name) {
  return Array.isArray(card?.["六维分析"])
    ? card["六维分析"].find((dimension) => isPlainObject(dimension) && dimension["维度"] === name)
    : null;
}

function priorCheckScore(previousState, dimensionName, checkName) {
  if (!isPlainObject(previousState) || !Array.isArray(previousState["维度"])) return null;
  const dimension = previousState["维度"].find((item) => isPlainObject(item) && item["维度"] === dimensionName);
  const check = Array.isArray(dimension?.["检查项"])
    ? dimension["检查项"].find((item) => isPlainObject(item) && item["检查项"] === checkName)
    : null;
  return isScore(check?.["分数"]) ? check["分数"] : null;
}

function legacyCheckScore(scorecard, dimensionName, checkName) {
  const dimension = scorecardDimension(scorecard, dimensionName);
  const check = Array.isArray(dimension?.["检查项"])
    ? dimension["检查项"].find((item) => isPlainObject(item) && item["检查项"] === checkName)
    : null;
  return scoreMidpointForGrade(check?.["评级"] || dimension?.["评级"] || "");
}

export function createReviewScoringState({ scriptHash, scorecard = null, previousState = null }) {
  const canReusePreviousScores = previousState?.["剧本哈希"] === scriptHash;
  return {
    "schema_version": REVIEW_SCORING_SCHEMA_VERSION,
    "评分表版本": SCORING_TABLE.schema_version,
    "评分表哈希": SCORING_TABLE_HASH,
    "剧本哈希": scriptHash,
    "维度": SCORING_TABLE["维度"].map((dimension) => ({
      "维度": dimension["名称"],
      "权重": dimension["权重"],
      "检查项": dimension["检查项"].map((check) => ({
        "检查项": check["名称"],
        "权重": check["权重"],
        "分数": canReusePreviousScores
          ? priorCheckScore(previousState, dimension["名称"], check["名称"])
          : legacyCheckScore(scorecard, dimension["名称"], check["名称"]),
        "评级": ""
      })),
      "得分": null,
      "评级": ""
    })),
    "总分": null,
    "总体评级": ""
  };
}

const REVIEW_SCORING_KEYS = Object.freeze(["schema_version", "评分表版本", "评分表哈希", "剧本哈希", "维度", "总分", "总体评级"]);
const SCORING_DIMENSION_KEYS = Object.freeze(["维度", "权重", "检查项", "得分", "评级"]);
const SCORING_CHECK_KEYS = Object.freeze(["检查项", "权重", "分数", "评级"]);

function reviewScoringStructureIssues(state, expectedScriptHash) {
  const issues = [];
  if (!hasExactKeys(state, REVIEW_SCORING_KEYS)) return ["内部评分状态字段不完整，请重新初始化海外审稿"];
  if (state.schema_version !== REVIEW_SCORING_SCHEMA_VERSION) issues.push("内部评分状态版本不匹配，请重新初始化海外审稿");
  if (state["评分表版本"] !== SCORING_TABLE.schema_version || state["评分表哈希"] !== SCORING_TABLE_HASH) {
    issues.push("内部评分状态与当前评分表不一致，请重新初始化海外审稿");
  }
  if (state["剧本哈希"] !== expectedScriptHash) issues.push("内部评分状态与当前剧本文本不一致，需要重新审读并评分");
  if (!Array.isArray(state["维度"]) || state["维度"].length !== SCORING_TABLE["维度"].length) {
    issues.push("内部评分状态必须包含评分表定义的全部维度");
    return issues;
  }
  state["维度"].forEach((dimension, dimensionIndex) => {
    const definition = SCORING_TABLE["维度"][dimensionIndex];
    const label = `内部评分“${definition["名称"]}”`;
    if (!hasExactKeys(dimension, SCORING_DIMENSION_KEYS)) {
      issues.push(`${label}字段不完整`);
      return;
    }
    if (dimension["维度"] !== definition["名称"] || dimension["权重"] !== definition["权重"]) issues.push(`${label}与评分表定义不一致`);
    if (!Array.isArray(dimension["检查项"]) || dimension["检查项"].length !== definition["检查项"].length) {
      issues.push(`${label}必须包含评分表定义的全部检查项`);
      return;
    }
    dimension["检查项"].forEach((check, checkIndex) => {
      const checkDefinition = definition["检查项"][checkIndex];
      const checkLabel = `${label}的“${checkDefinition["名称"]}”`;
      if (!hasExactKeys(check, SCORING_CHECK_KEYS)) {
        issues.push(`${checkLabel}字段不完整`);
        return;
      }
      if (check["检查项"] !== checkDefinition["名称"] || check["权重"] !== checkDefinition["权重"]) issues.push(`${checkLabel}与评分表定义不一致`);
      if (!isScore(check["分数"])) issues.push(`${checkLabel}必须填写 0-100 分的分数`);
    });
  });
  return issues;
}

export function calculateReviewScoringState(state, expectedScriptHash) {
  const issues = reviewScoringStructureIssues(state, expectedScriptHash);
  if (issues.length) {
    const error = new Error(`内部评分尚未完成：${issues.join("；")}`);
    error.issues = issues;
    throw error;
  }
  const calculated = structuredClone(state);
  calculated["维度"].forEach((dimension) => {
    dimension["检查项"].forEach((check) => {
      check["评级"] = gradeForScore(check["分数"]);
    });
    dimension["得分"] = roundScore(dimension["检查项"].reduce(
      (total, check) => total + check["分数"] * check["权重"] / 100,
      0
    ));
    dimension["评级"] = gradeForScore(dimension["得分"]);
  });
  calculated["总分"] = roundScore(calculated["维度"].reduce(
    (total, dimension) => total + dimension["得分"] * dimension["权重"] / 100,
    0
  ));
  calculated["总体评级"] = overallGradeForScore(calculated["总分"]);
  return calculated;
}

export function validateReviewScoringState(state, expectedScriptHash) {
  let calculated;
  try {
    calculated = calculateReviewScoringState(state, expectedScriptHash);
  } catch (error) {
    return { ok: false, issues: Array.isArray(error.issues) ? error.issues : [error.message] };
  }
  const issues = [];
  calculated["维度"].forEach((expectedDimension, dimensionIndex) => {
    const actualDimension = state["维度"][dimensionIndex];
    expectedDimension["检查项"].forEach((expectedCheck, checkIndex) => {
      if (actualDimension["检查项"][checkIndex]["评级"] !== expectedCheck["评级"]) {
        issues.push(`内部评分“${expectedDimension["维度"]}”的“${expectedCheck["检查项"]}”评级未按分数更新`);
      }
    });
    if (!sameScore(actualDimension["得分"], expectedDimension["得分"]) || actualDimension["评级"] !== expectedDimension["评级"]) {
      issues.push(`内部评分“${expectedDimension["维度"]}”的得分或评级未按检查项分数更新`);
    }
  });
  if (!sameScore(state["总分"], calculated["总分"]) || state["总体评级"] !== calculated["总体评级"]) {
    issues.push("内部评分的总分或总体评级未按六维权重更新");
  }
  return { ok: !issues.length, issues, calculated };
}

function sameScore(left, right) {
  return typeof left === "number" && typeof right === "number" && Math.abs(left - right) < 0.001;
}

export function synchronizeScorecardGrades(scorecard, scoringState) {
  if (!admissionAllowsScoring(scorecard)) throw new Error("无法同步评分卡：剧本尚未通过准入标准");
  const validation = validateReviewScoringState(scoringState, scoringState?.["剧本哈希"]);
  if (!validation.ok) throw new Error(`无法同步评分卡：${validation.issues.join("；")}`);
  const next = structuredClone(scorecard);
  if (!Array.isArray(next["六维分析"]) || !isPlainObject(next["评级依据"]) || !Array.isArray(next["评级依据"]["六维结论"]) || !isPlainObject(next["总体结论"])) {
    throw new Error("无法同步评分卡：评分卡缺少六维分析、评级概述或总体结论");
  }
  validation.calculated["维度"].forEach((scoringDimension) => {
    const dimension = next["六维分析"].find((item) => isPlainObject(item) && item["维度"] === scoringDimension["维度"]);
    const basis = next["评级依据"]["六维结论"].find((item) => isPlainObject(item) && item["分析维度"] === scoringDimension["维度"]);
    if (!isPlainObject(dimension) || !Array.isArray(dimension["检查项"]) || !isPlainObject(basis)) {
      throw new Error(`无法同步评分卡：缺少“${scoringDimension["维度"]}”的对外分析项`);
    }
    scoringDimension["检查项"].forEach((scoringCheck) => {
      const check = dimension["检查项"].find((item) => isPlainObject(item) && item["检查项"] === scoringCheck["检查项"]);
      if (!isPlainObject(check)) throw new Error(`无法同步评分卡：缺少“${scoringCheck["检查项"]}”检查项`);
      check["评级"] = scoringCheck["评级"];
    });
    dimension["评级"] = scoringDimension["评级"];
    basis["评级"] = scoringDimension["评级"];
    basis["结论"] = reviewResultForGrade(scoringDimension["评级"]);
  });
  next["总体结论"]["评级"] = validation.calculated["总体评级"];
  return next;
}

export function upgradeReviewScorecard(card) {
  if (!isPlainObject(card) || card.schema_version === SCORECARD_SCHEMA_VERSION) return { scorecard: card, changed: false };
  if (!["2.1.0", "2.2.0", "2.3.0", "2.4.0", "2.5.0", "2.6.0", "2.7.0", "2.8.0"].includes(card.schema_version)) return { scorecard: card, changed: false };
  const scorecard = structuredClone(card);
  if (isPlainObject(scorecard["审稿信息"])) {
    delete scorecard["审稿信息"]["目标平台"];
    scorecard["审稿信息"]["内容分级"] = resolveMaturityTarget(scorecard["审稿信息"]["内容分级"]);
  }
  if (!isPlainObject(scorecard["准入标准"])) scorecard["准入标准"] = createAdmissionGate();
  if (scorecard.schema_version === "2.1.0") {
    const oldBasis = isPlainObject(scorecard["评级依据"]) ? scorecard["评级依据"] : {};
    scorecard["评级依据"] = {
      "综合判定": "",
      "审读范围": oldBasis["审读范围"] || "",
      "审稿方法": oldBasis["决策方法"] || oldBasis["审稿方法"] || "",
      "六维结论": Array.isArray(oldBasis["六维结论"]) ? oldBasis["六维结论"] : []
    };
    if (Array.isArray(scorecard["六维分析"])) {
      scorecard["六维分析"] = scorecard["六维分析"].map((dimension) => {
        if (!isPlainObject(dimension)) return dimension;
        const { "表格导读": _unused, ...rest } = dimension;
        return rest;
      });
    }
  }
  if (isPlainObject(scorecard["剧本信息"])) {
    const { "频类": _frequency, "一句话介绍": _oneLineSummary, ...information } = scorecard["剧本信息"];
    scorecard["剧本信息"] = information;
  }
  if (Array.isArray(scorecard["卖点拆解"])) {
    scorecard["卖点拆解"] = scorecard["卖点拆解"].map((item) => (
      isPlainObject(item) && item["状态"] === "尚未兑现"
        ? { ...item, "状态": "兑现不足" }
        : item
    ));
  }
  if (card.schema_version !== "2.7.0" && Array.isArray(scorecard["六维分析"])) {
    scorecard["六维分析"] = scorecard["六维分析"].map((dimension) => {
      if (!isPlainObject(dimension) || dimension["维度"] !== "成片与制作" || !Array.isArray(dimension["检查项"])) return dimension;
      return {
        ...dimension,
        "检查项": dimension["检查项"].map((item) => (
          isPlainObject(item) && item["检查项"] === "90 秒承载"
            ? { ...item, "检查项": "内容量承载" }
            : item
        ))
      };
    });
  }
  if (card.schema_version !== "2.7.0" && Array.isArray(scorecard["六维分析"])) {
    scorecard["六维分析"] = scorecard["六维分析"].map((dimension) => {
      if (!isPlainObject(dimension) || dimension["维度"] !== "发行与风险") return dimension;
      return {
        ...dimension,
        "评级": "",
        "判断": "",
        "检查项": REQUIRED_CHECKS["发行与风险"].map((name) => ({
          "检查项": name,
          "评级": "",
          "问题说明": "",
          "原稿证据": []
        }))
      };
    });
  }
  if (card.schema_version !== "2.7.0" && isPlainObject(scorecard["评级依据"]) && Array.isArray(scorecard["评级依据"]["六维结论"])) {
    scorecard["评级依据"]["六维结论"] = scorecard["评级依据"]["六维结论"].map((item) => (
      isPlainObject(item) && item["分析维度"] === "发行与风险"
        ? { ...item, "评级": "", "结论": "", "一句话判断": "" }
        : item
    ));
  }
  if (isPlainObject(scorecard["评级依据"])) {
    scorecard["评级依据"]["审稿方法"] = REVIEW_METHOD_TEMPLATE;
  }
  if (isPlainObject(scorecard["总体结论"]) && /-$/.test(scorecard["总体结论"]["评级"] || "")) {
    scorecard["总体结论"]["评级"] = baseGrade(scorecard["总体结论"]["评级"]);
  }
  scorecard.schema_version = SCORECARD_SCHEMA_VERSION;
  return { scorecard, changed: true };
}

export function renderReportScaffold(scorecard = {}) {
  const information = isPlainObject(scorecard["剧本信息"]) ? scorecard["剧本信息"] : {};
  const reviewInfo = isPlainObject(scorecard["审稿信息"]) ? scorecard["审稿信息"] : {};
  const sellingPoints = Array.isArray(scorecard["卖点拆解"]) ? scorecard["卖点拆解"] : [];
  const scriptName = optionalText(information["剧本名称"]);
  const sellingPointSections = sellingPoints.length
    ? sellingPoints.flatMap((item, index) => [
      `${index + 1}. **${item["卖点"] || "卖点名称"}**（${item["状态"] || "状态"}）`,
      `   - 观众吸引力：${item["观众为什么看"] || ""}`,
      `   - 正文兑现：${item["是否兑现"] || ""}`
    ])
    : [
      "1. **卖点名称**（状态）",
      "   - 观众吸引力：",
      "   - 正文兑现："
    ];
  const dimensionSections = DIMENSIONS.flatMap((name, index) => [
    "",
    `### ${index + 1}. ${name}`,
    "",
    "维度结论。",
    "",
    "| 检查项 | 评级 | 问题说明 | 原稿证据 |",
    "| --- | --- | --- | --- |"
  ]);
  return [
    `# 《${scriptName}》审稿报告`,
    "",
    "## 一、审核结论",
    "",
    "### 1. 整体结论",
    "",
    "> **审核结论：**",
    ">",
    "> **总体评级：**",
    ">",
    "> **一句话评估：**",
    "",
    "结论说明。",
    "",
    "### 2. 剧本信息",
    "",
    `- 剧集名称：${information["剧本名称"] || ""}`,
    `- 目标市场：${reviewInfo["目标市场"] || ""}`,
    `- 目标语与时长：${[reviewInfo["目标语"], reviewInfo["单集时长"]].filter(isText).join("，")}`,
    `- 内容分级：${reviewInfo["内容分级"] || ""}`,
    `- 剧情梗概：${information["剧情梗概"] || ""}`,
    `- 题材：${Array.isArray(information["题材"]) ? information["题材"].join("、") : ""}`,
    `- 剧本标签：${Array.isArray(information["剧本标签"]) ? information["剧本标签"].join("、") : ""}`,
    "",
    "### 3. 核心卖点",
    "",
    "核心卖点结论。",
    "",
    ...sellingPointSections,
    "",
    "## 二、准入标准",
    "",
    "准入结论正文。",
    "",
    "| 检查项 | 结果 | 说明 |",
    "| --- | --- | --- |",
    ...ADMISSION_CHECKS.map((name) => `| ${name} |  |  |`),
    "",
    "## 三、评级概述",
    "",
    "综合判定正文。",
    "",
    "### 1. 审读范围",
    "",
    "审读范围正文。",
    "",
    "### 2. 审稿方法",
    "",
    REVIEW_METHOD_TEMPLATE,
    "",
    "### 3. 维度结论",
    "",
    "| 分析维度 | 评级 | 结论 | 一句话判断 |",
    "| --- | --- | --- | --- |",
    "",
    "## 四、评分细则",
    "",
    "本稿应重点关注 **维度名称** 的关键问题及其对主线、人物或留存的影响。",
    ...dimensionSections,
    "",
    "## 五、修改建议",
    "",
    "本轮问题结论。",
    "",
    "### 1. P0 问题",
    "> P0：不解决会影响项目能否成立或能否进入下一阶段，必须先完成返修。",
    "- 当前未识别 P0 问题。",
    "",
    "### 2. P1 问题",
    "> P1：不改变项目的基本成立性，但会明显影响留存、质感或交付效率，应在本轮返修中一并处理。",
    "- 当前未识别 P1 问题。",
    "",
    "## 六、最终结论",
    ""
  ].join("\n");
}
