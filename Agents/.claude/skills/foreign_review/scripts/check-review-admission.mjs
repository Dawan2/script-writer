#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ADMISSION_CHECKS,
  ADMISSION_RESULTS,
  admissionConclusionForItems,
  createReviewScoringState,
  hashText,
  isPlainObject,
  isText,
  normalizeLines,
  readJson,
  resolveReviewInput,
  REVIEW_SCORING_RELATIVE_PATH,
  writeJson
} from "./foreign-review-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ADMISSION_KEYS = Object.freeze(["结论", "一句话判断", "检查项", "修改建议"]);
const ADMISSION_ITEM_KEYS = Object.freeze(["检查项", "结果", "说明", "原稿证据"]);
const PROCEDURAL_LANGUAGE = /(?:本次|当前|经(?:过)?|已)(?:审读|核对)|(?:工具|模型)(?:识别|确认|显示|分析|判断)|证据见(?:正文|原文)?|(?:正文|文本)(?:出现|显示|可见)|无法(?:可靠)?确认|分析过程|以下将/u;
const MIN_EPISODE_CHARACTERS = 240;
const MIN_EPISODE_NON_EMPTY_LINES = 3;

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") throw new Error("请使用 --workspace <项目目录>");
  const cwdWorkspace = path.resolve(argv[1]);
  const workspace = path.isAbsolute(argv[1]) || existsSync(cwdWorkspace) ? cwdWorkspace : path.resolve(agentRoot, argv[1]);
  return { workspace };
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateEvidence(evidence, label, lines, issues) {
  if (!Array.isArray(evidence) || !evidence.length) {
    issues.push(`${label}至少需要一条原稿证据`);
    return;
  }
  evidence.forEach((item, index) => {
    const start = item?.["起始行"];
    const end = item?.["结束行"];
    if (!isPlainObject(item) || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 1 || end < start || end > lines.length || !lines.slice(start - 1, end).join("\n").trim()) {
      issues.push(`${label}第 ${index + 1} 条证据的行号无效`);
      return;
    }
    if (!isText(item["说明"])) issues.push(`${label}第 ${index + 1} 条证据缺少说明`);
  });
}

export function hasProceduralLanguage(value) {
  return PROCEDURAL_LANGUAGE.test(String(value || ""));
}

function validateAdmissionDescription(description, label, issues) {
  const value = String(description || "").trim();
  if (!/^\*\*[^*\r\n]{6,100}[。！？]\*\*$/u.test(value)) {
    issues.push(`${label}的说明必须只写一条加粗的编辑结论，不附加行号、依据或流水式证据`);
  }
  if (hasProceduralLanguage(value)) {
    issues.push(`${label}的说明不应包含分析过程话语，应直接写结论和原稿事实`);
  }
  if (/(?:依据|证据)：|第\s*\d+\s*[-~至—]\s*\d+\s*行/u.test(value)) {
    issues.push(`${label}的说明不应展示原稿行号或证据清单`);
  }
}

export function episodeCountAssessment(index) {
  const episodeCount = Array.isArray(index?.units) ? index.units.filter((unit) => unit?.type === "剧集").length : 0;
  if (index?.structure_status !== "规范分集") {
    return {
      result: "部分通过",
      episodeCount,
      reason: "分集格式不足以可靠确认正式集数"
    };
  }
  if (episodeCount >= 30) {
    return { result: "通过", episodeCount, reason: "达到完整审稿的最低集数" };
  }
  if (episodeCount >= 10) {
    return { result: "部分通过", episodeCount, reason: "达到部分审稿的最低集数" };
  }
  return { result: "不通过", episodeCount, reason: "未达到部分审稿的最低集数" };
}

function validateEpisodeThreshold(item, index, issues) {
  if (!isPlainObject(item) || !isPlainObject(index)) return;
  const assessment = episodeCountAssessment(index);
  if (item["结果"] !== assessment.result) {
    const count = index.structure_status === "规范分集" ? `当前可确认的 ${assessment.episodeCount} 集` : "当前分集结构";
    issues.push(`集数达标应根据${count}判定为“${assessment.result}”`);
  }
}

export function contentDensityAssessment(index) {
  const episodes = Array.isArray(index?.units) ? index.units.filter((unit) => unit?.type === "剧集") : [];
  if (index?.structure_status !== "规范分集" || !episodes.length) {
    return {
      result: "不通过",
      underloaded: [],
      reason: "未形成可逐集统计的交付结构"
    };
  }
  const underloaded = episodes.filter((episode) => {
    const stats = episode?.mechanical_stats || {};
    return Number(stats.characters || 0) < MIN_EPISODE_CHARACTERS
      || Number(stats.non_empty_lines || 0) < MIN_EPISODE_NON_EMPTY_LINES;
  });
  if (!underloaded.length) {
    return { result: "通过", underloaded, reason: "全部剧集达到最低文本承载量" };
  }
  const partialLimit = Math.max(2, Math.floor(episodes.length * 0.1));
  return {
    result: underloaded.length <= partialLimit ? "部分通过" : "不通过",
    underloaded,
    reason: `${underloaded.length} 集低于最低文本承载量`
  };
}

function validateContentDensity(item, index, issues) {
  if (!isPlainObject(item)) return;
  const assessment = contentDensityAssessment(index);
  if (item["结果"] !== assessment.result) {
    issues.push(`内容密度必须依据逐集文本统计判定为“${assessment.result}”`);
  }
}

function validateTitleFulfillment(item, issues) {
  if (item?.["结果"] === "部分通过") {
    issues.push("标题承诺兑现只能判定为“通过”或“不通过”，不得使用“部分通过”");
  }
}

export function validateAdmissionGate(admission, index, lines) {
  const issues = [];
  if (!hasExactKeys(admission, ADMISSION_KEYS)) return { ok: false, issues: ["准入标准字段必须与评分卡模板一致"] };
  if (!isText(admission["一句话判断"]) || admission["一句话判断"].trim().length < 12) {
    issues.push("准入标准的一句话判断需要说明当前是否具备继续评级的条件");
  }
  const items = admission["检查项"];
  if (!Array.isArray(items) || items.length !== ADMISSION_CHECKS.length) {
    issues.push(`准入标准必须包含 ${ADMISSION_CHECKS.length} 个固定检查项`);
    return { ok: false, issues };
  }
  items.forEach((item, itemIndex) => {
    const expectedName = ADMISSION_CHECKS[itemIndex];
    const label = `准入标准“${expectedName}”`;
    if (!hasExactKeys(item, ADMISSION_ITEM_KEYS) || item["检查项"] !== expectedName) {
      issues.push(`${label}必须按固定顺序使用“检查项、结果、说明、原稿证据”字段`);
      return;
    }
    if (!ADMISSION_RESULTS.includes(item["结果"])) issues.push(`${label}的结果只能为通过、部分通过或不通过`);
    validateEvidence(item["原稿证据"], label, lines, issues);
    validateAdmissionDescription(item["说明"], label, issues);
  });
  validateEpisodeThreshold(items[0], index, issues);
  validateContentDensity(items[1], index, issues);
  validateTitleFulfillment(items[3], issues);
  const expectedConclusion = admissionConclusionForItems(items);
  const suggestions = admission["修改建议"];
  if (!Array.isArray(suggestions) || suggestions.some((item) => !isText(item))) {
    issues.push("准入标准的修改建议必须是文本数组");
  } else if (expectedConclusion === "不通过" && (!suggestions.length || suggestions.length > 10)) {
    issues.push("准入不通过时需要提供 1 至 10 条直接可执行的修改建议");
  }
  return { ok: !issues.length, issues, conclusion: expectedConclusion };
}

function clearPublicRatings(scorecard) {
  const next = structuredClone(scorecard);
  if (isPlainObject(next["总体结论"])) next["总体结论"]["评级"] = "未评级";
  if (Array.isArray(next["六维分析"])) {
    next["六维分析"].forEach((dimension) => {
      if (!isPlainObject(dimension)) return;
      dimension["评级"] = "";
      dimension["判断"] = "";
      if (Array.isArray(dimension["检查项"])) dimension["检查项"].forEach((item) => {
        if (isPlainObject(item)) item["评级"] = "";
      });
    });
  }
  const conclusions = next["评级依据"]?.["六维结论"];
  if (Array.isArray(conclusions)) conclusions.forEach((item) => {
    if (!isPlainObject(item)) return;
    item["评级"] = "";
    item["结论"] = "";
    item["一句话判断"] = "";
  });
  next["P0问题"] = [];
  next["P1问题"] = [];
  return next;
}

export async function checkReviewAdmission(workspace) {
  const workspaceDir = path.resolve(workspace);
  const input = await resolveReviewInput(workspaceDir);
  const [scriptText, scorecard, index] = await Promise.all([
    fs.readFile(input.scriptPath, "utf8"),
    readJson(path.join(workspaceDir, "review-scorecard.json")),
    readJson(path.join(workspaceDir, "runtime", "review-source-index.json"))
  ]);
  const scriptHash = hashText(scriptText);
  if (index?.script_hash !== scriptHash) throw new Error("审读索引与当前剧本不一致，请重新建立审读索引");
  const validation = validateAdmissionGate(scorecard["准入标准"], index, normalizeLines(scriptText));
  if (!validation.ok) return { ok: false, issues: validation.issues };

  let nextScorecard = structuredClone(scorecard);
  nextScorecard["准入标准"]["结论"] = validation.conclusion;
  const admitted = ["通过", "部分通过"].includes(validation.conclusion);
  if (!admitted) nextScorecard = clearPublicRatings(nextScorecard);
  else if (nextScorecard["总体结论"]?.["评级"] === "未评级") nextScorecard["总体结论"]["评级"] = "";

  const writes = [writeJson(path.join(workspaceDir, "review-scorecard.json"), nextScorecard)];
  if (!admitted) {
    writes.push(writeJson(
      path.join(workspaceDir, REVIEW_SCORING_RELATIVE_PATH),
      createReviewScoringState({ scriptHash, scorecard: nextScorecard })
    ));
  }
  await Promise.all(writes);
  return {
    ok: true,
    admission: validation.conclusion,
    continue_to_scoring: admitted,
    next_action: admitted
      ? "继续完成六维分析并计算审稿评分。"
      : "停止六维评分，生成准入不通过报告和最终修改建议。"
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkReviewAdmission(parseArgs(process.argv.slice(2)).workspace)
    .then((result) => {
      const stream = result.ok ? process.stdout : process.stderr;
      stream.write(`${JSON.stringify({ ...result, stage: "foreign_review", tool: "check-review-admission" }, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        stage: "foreign_review",
        tool: "check-review-admission",
        message: error.message,
        next_action: "检查准入标准、审读索引和原稿证据后重试。"
      }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
