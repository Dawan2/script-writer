#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { assertScriptProfileResolved } from "../../../tools/script-profile.mjs";
import {
  ANALYSIS_RELATIVE_PATH,
  deriveNovelOutlinePlan,
  HIGHLIGHT_INDEX_RE,
  INDEX_RELATIVE_PATH,
  isPlainObject
} from "./novel-analysis-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const MAX_PRIMARY_CHARACTERS = 10;

function parseArgs(argv) {
  const validateOnly = argv.includes("--validate-only");
  const values = argv.filter((item) => item !== "--validate-only");
  if (values.length !== 4 || values[0] !== "--workspace" || values[2] !== "--updated-by") throw new Error("请使用 --workspace <项目目录> --updated-by <用户> [--validate-only]");
  return { workspace: path.resolve(agentRoot, values[1]), updatedBy: values[3] || "admin", validateOnly };
}

function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function text(value, label, issues) {
  if (typeof value !== "string" || !value.trim()) issues.push(`${label}不能为空`);
}

function textList(value, label, issues, { minimum = 1 } = {}) {
  if (!Array.isArray(value) || value.length < minimum) {
    issues.push(`${label}至少需要 ${minimum} 项`);
    return;
  }
  value.forEach((item, index) => text(item, `${label}第 ${index + 1} 项`, issues));
}

function basicInfo(value, issues) {
  const keys = ["小说名称", "小说梗概", "题材", "基调"];
  if (!exactKeys(value, keys)) {
    issues.push("基础信息字段必须与模板一致");
    return;
  }
  text(value["小说名称"], "基础信息的小说名称", issues);
  text(value["小说梗概"], "基础信息的小说梗概", issues);
  textList(value["题材"], "基础信息的题材", issues);
  text(value["基调"], "基础信息的基调", issues);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function recommendationCounts(units) {
  return units.reduce((counts, unit) => {
    if (unit?.["改编建议"] === "保留") counts.retain += 1;
    else if (unit?.["改编建议"] === "删除") counts.delete += 1;
    else if (unit?.["改编建议"] === "合并") counts.merge += 1;
    return counts;
  }, { retain: 0, delete: 0, merge: 0 });
}

function confirmedMergeCount(units) {
  return units.filter((unit) => unit?.["已确认合并"] === true).length;
}

function validateAdaptationRecommendations(units, issues) {
  const unitsById = new Map(units.map((unit) => [normalizeText(unit?.["单元ID"]), unit]));
  units.forEach((unit, index) => {
    const label = `剧情单元第 ${index + 1} 项`;
    const recommendation = unit?.["改编建议"];
    const targetValue = unit?.["合并目标单元ID"];
    const confirmedMerge = unit?.["已确认合并"];
    if (typeof confirmedMerge !== "boolean") {
      issues.push(`${label}的已确认合并必须是布尔值`);
      return;
    }
    if (typeof targetValue !== "string") {
      issues.push(`${label}的合并目标单元ID必须是字符串`);
      return;
    }
    const targetId = targetValue.trim();
    if (recommendation !== "合并") {
      if (targetId) issues.push(`${label}不是建议合并时，合并目标单元ID必须为空`);
      if (confirmedMerge) issues.push(`${label}不是建议合并时，已确认合并必须为 false`);
      return;
    }
    if (!targetId) {
      issues.push(`${label}建议合并时必须指定合并目标单元ID`);
      return;
    }
    if (targetId === normalizeText(unit?.["单元ID"])) {
      issues.push(`${label}不能合并到自身`);
      return;
    }
    const targetUnit = unitsById.get(targetId);
    if (!targetUnit) {
      issues.push(`${label}的合并目标单元ID无效：${targetId}`);
      return;
    }
    if (targetUnit["改编建议"] !== "保留") {
      issues.push(`${label}只能并入建议保留的剧情单元：${targetId}`);
    }
  });
}

export async function checkNovelAnalysis(workspace, updatedBy = "admin", { validateOnly = false } = {}) {
  const workspaceDir = path.resolve(workspace);
  const [analysis, index, userInput] = await Promise.all([
    fs.readFile(path.join(workspaceDir, ANALYSIS_RELATIVE_PATH), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, INDEX_RELATIVE_PATH), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse)
  ]);
  const adaptationPlan = deriveNovelOutlinePlan(userInput.project);
  const issues = [];
  try {
    assertScriptProfileResolved(userInput.project, "novel_analysis");
  } catch (error) {
    issues.push(error.message);
  }
  const topKeys = ["基础信息", "核心卖点", "故事主线", "世界观", "关键人物", "剧情单元"];
  if (!exactKeys(analysis, topKeys)) issues.push("顶层字段必须与 novel-analysis.json5 一致");
  basicInfo(analysis["基础信息"], issues);
  text(analysis["核心卖点"], "核心卖点", issues);
  text(analysis["故事主线"], "故事主线", issues);
  text(analysis["世界观"], "世界观", issues);

  const characters = analysis["关键人物"];
  const characterNames = new Set();
  if (!Array.isArray(characters) || !characters.length) issues.push("关键人物至少需要一人");
  else {
    if (characters.length > MAX_PRIMARY_CHARACTERS) issues.push(`关键人物最多 ${MAX_PRIMARY_CHARACTERS} 人，请仅保留会持续改变主线且有独立弧光或终局回报的主要角色`);
    characters.forEach((item, indexValue) => {
      const label = `关键人物第 ${indexValue + 1} 项`;
      if (!exactKeys(item, ["人物名称", "人物画像"])) {
        issues.push(`${label}字段必须与模板一致`);
        return;
      }
      ["人物名称", "人物画像"].forEach((key) => text(item[key], `${label}的${key}`, issues));
      const name = typeof item["人物名称"] === "string" ? item["人物名称"].trim() : "";
      if (name && characterNames.has(name)) issues.push(`${label}的人物名称重复：${name}`);
      if (name) characterNames.add(name);
    });
  }

  const units = analysis["剧情单元"];
  const unitIds = new Set();
  if (!Array.isArray(units) || !units.length) issues.push("剧情单元至少需要一个单元");
  else units.forEach((unit, unitIndex) => {
    const label = `剧情单元第 ${unitIndex + 1} 项`;
    const unitKeys = ["单元ID", "单元名称", "单元梗概", "主线推进", "关键人物", "关键信息", "高光时刻", "改编建议", "合并目标单元ID", "已确认合并", "建议原因"];
    if (!exactKeys(unit, unitKeys)) {
      issues.push(`${label}字段必须与模板一致`);
      return;
    }
    ["单元ID", "单元名称", "单元梗概", "主线推进"].forEach((key) => text(unit[key], `${label}的${key}`, issues));
    const unitId = typeof unit["单元ID"] === "string" ? unit["单元ID"].trim() : "";
    if (unitId && !/^unit-[a-z0-9-]+$/u.test(unitId)) issues.push(`${label}的单元ID格式无效`);
    if (unitId && unitIds.has(unitId)) issues.push(`${label}的单元ID重复：${unitId}`);
    if (unitId) unitIds.add(unitId);
    if (!["保留", "删除", "合并"].includes(unit["改编建议"])) issues.push(`${label}的改编建议只能为保留、删除或合并`);
    text(unit["建议原因"], `${label}的建议原因`, issues);
    const roles = unit["关键人物"];
    if (!Array.isArray(roles) || !roles.length) issues.push(`${label}至少需要一名关键人物`);
    else roles.forEach((role, roleIndex) => {
      if (!exactKeys(role, ["人物名称", "单元作用与变化"])) issues.push(`${label}的关键人物第 ${roleIndex + 1} 项字段必须与模板一致`);
      else {
        text(role["人物名称"], `${label}的关键人物第 ${roleIndex + 1} 项人物名称`, issues);
        text(role["单元作用与变化"], `${label}的关键人物第 ${roleIndex + 1} 项作用与变化`, issues);
      }
    });
    textList(unit["关键信息"], `${label}的关键信息`, issues);
    const highlights = unit["高光时刻"];
    if (!Array.isArray(highlights) || !highlights.length) issues.push(`${label}至少需要一个高光时刻`);
    else highlights.forEach((highlight, highlightIndex) => {
      const highlightLabel = `${label}的高光时刻第 ${highlightIndex + 1} 项`;
      if (!exactKeys(highlight, ["名称", "原文索引"])) {
        issues.push(`${highlightLabel}字段必须与模板一致`);
        return;
      }
      text(highlight["名称"], `${highlightLabel}名称`, issues);
      const match = HIGHLIGHT_INDEX_RE.exec(highlight["原文索引"] || "");
      if (!match) issues.push(`${highlightLabel}原文索引应为 L起始行-L结束行`);
      else {
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (start < 1 || end < start || end > index.total_lines) issues.push(`${highlightLabel}原文索引超出 1-${index.total_lines} 行范围`);
        if (end - start + 1 > 160) issues.push(`${highlightLabel}原文索引超过 160 行，请缩小到高光必要范围`);
      }
    });
  });

  const unitList = Array.isArray(units) ? units : [];
  const counts = recommendationCounts(unitList);
  const confirmedMerges = confirmedMergeCount(unitList);
  validateAdaptationRecommendations(unitList, issues);
  if (unitList.length && counts.retain < 1) {
    issues.push("剧情单元至少需要一个建议保留的单元");
  }

  if (issues.length) {
    return {
      ok: false,
      issues: [...new Set(issues)],
      adaptation_plan: adaptationPlan,
      recommendation_counts: counts,
      confirmed_merge_count: confirmedMerges
    };
  }
  if (!validateOnly) {
    await updateProgress({
      workspace: workspaceDir,
      stage: "novel_analysis",
      status: "completed",
      updatedBy,
      nextSkill: "outline_rewrite",
      outputFiles: [ANALYSIS_RELATIVE_PATH, INDEX_RELATIVE_PATH]
    });
  }
  return {
    ok: true,
    ...(validateOnly ? { validation_only: true } : {}),
    analysis_file: path.join(workspaceDir, ANALYSIS_RELATIVE_PATH),
    unit_count: unitList.length,
    adaptation_plan: adaptationPlan,
    recommendation_counts: counts,
    confirmed_merge_count: confirmedMerges
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await checkNovelAnalysis(args.workspace, args.updatedBy, { validateOnly: args.validateOnly });
    if (!result.ok) {
      process.stderr.write(`${JSON.stringify({ ...result, stage: "novel_analysis", tool: "check", next_action: "只修复 2.1-novel-analysis.json 中返回的问题后重新检查。" }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ ...result, message: "小说解读已通过检查。", next_action: "用户删除的单元不会继续传递；只有已确认合并的单元才在 outline_rewrite 中并入目标单元。" }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "novel_analysis", tool: "check", message: error.message, next_action: "检查小说解读、原文索引和 JSON 格式后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
