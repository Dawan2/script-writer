#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectOutlineEpisodes } from "./init-trial.mjs";
import { englishNameByChineseName } from "../../outline_rewrite/scripts/role-name-map.mjs";
import { readNovelAnalysis, sourceUnitsForReferences } from "../../novel_analysis/scripts/novel-analysis-utils.mjs";
import { resolveMaturityTarget } from "../../../tools/distribution-brief.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workspaceRoot = path.join(agentRoot, "workspaces");

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`无法识别参数：${key}`);
    const name = key.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || args[name] !== undefined) throw new Error(`参数 --${name} 无效或重复`);
    args[name] = value;
    index += 1;
  }
  if (!args.workspace || (args.episode && args.unit)) {
    throw new Error("请使用 --workspace <项目目录>；查询具体内容时只能额外传入 --episode <集数> 或 --unit <单元名称>");
  }
  const workspace = path.resolve(agentRoot, args.workspace);
  if (!isInside(workspaceRoot, workspace)) throw new Error("项目目录必须位于 workspaces/ 下");
  if (args.episode && (!/^\d+$/u.test(args.episode) || Number(args.episode) < 1)) throw new Error("--episode 必须是正整数");
  return { workspace, episode: args.episode ? Number(args.episode) : null, unit: args.unit || "" };
}

function roleNames(entries) {
  const names = new Set();
  entries.forEach((entry) => {
    for (const role of [...(entry.stage_roles || []), ...(entry.episode_info?.["关键角色"] || [])]) {
      if (typeof role === "string" && role.trim()) names.add(role.trim());
    }
  });
  return names;
}

function currentStageCharacter(character, stageName) {
  const currentStageName = typeof stageName === "string" ? stageName.trim() : "";
  const stages = Array.isArray(character?.["阶段变化"]) ? character["阶段变化"] : [];
  const writingCharacter = {};
  ["人物名称", "核心诉求", "人物难题", "关系与弧光"].forEach((field) => {
    if (typeof character?.[field] === "string") writingCharacter[field] = character[field];
  });
  return {
    ...writingCharacter,
    "阶段变化": stages.filter((stage) => (
      typeof stage?.["故事阶段"] === "string" && stage["故事阶段"].trim() === currentStageName
    ))
  };
}

function nextAction(taskType, sourceHighlights) {
  if (taskType !== "novel") {
    return "只编写本次返回的剧集，不扩展试稿范围；继续按照 Skill 工作流程，执行后续步骤。";
  }
  const highLightReading = "先阅读[高光时刻剧本改编原则](../novel_analysis/references/高光时刻剧本改编原则.md)，再逐项调用“读取小说高光原文”";
  if (!sourceHighlights.length) {
    return `${highLightReading}。当前范围未返回高光索引，请核对大纲中的原著剧情单元关联后重新获取；不得回读完整小说。`;
  }
  return `${highLightReading}读取 source_highlights 中的 source_index；然后继续按照 Skill 工作流程，执行后续步骤。`;
}

export async function getEpisodeInfo(workspace, { episode = null, unit = "" } = {}) {
  const [outline, characters, userInput] = await Promise.all([
    fs.readFile(path.join(workspace, "3.1-outline.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspace, "4.1-character.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8").then(JSON.parse).catch((error) => {
      if (error?.code === "ENOENT") return { project: { task_type: "rewrite" } };
      throw error;
    })
  ]);
  if (!Array.isArray(characters)) throw new Error("4.1-character.json 顶层必须是数组");
  const entries = collectOutlineEpisodes(outline).slice(0, 10);
  const selected = episode
    ? entries.filter((entry) => entry.episode === episode)
    : entries.filter((entry) => entry.stage_name === unit);
  if (!selected.length) throw new Error(episode ? `未找到第 ${episode} 集` : `未找到故事阶段：${unit}`);
  const names = roleNames(selected);
  const englishNames = englishNameByChineseName(outline);
  const unmappedNames = [...names].filter((name) => !englishNames.has(name));
  if (unmappedNames.length) {
    throw new Error(`3.1-outline.json 的关键角色名称映射缺少中文名称：${unmappedNames.join("、")}`);
  }
  const taskType = userInput.project?.task_type || "rewrite";
  const novelAnalysis = taskType === "novel" ? await readNovelAnalysis(workspace) : null;
  const sourceHighlights = novelAnalysis
    ? sourceUnitsForReferences(novelAnalysis, selected[0].source_unit_ids)
    : [];
  return {
    task_type: taskType,
    maturity_target: resolveMaturityTarget(userInput.project?.distribution_brief),
    next_action: nextAction(taskType, sourceHighlights),
    story_stage: {
      name: selected[0].stage_name,
      description: selected[0].stage_description,
      key_roles: [...new Set(selected.flatMap((entry) => entry.stage_roles))]
    },
    episodes: selected.map((entry) => entry.episode_info),
    source_highlights: sourceHighlights,
    characters: characters
      .filter((character) => names.has(character?.["人物名称"]))
      .map((character) => currentStageCharacter(character, selected[0].stage_name))
  };
}

export async function getTrialUnitSummary(workspace) {
  const outline = await fs.readFile(path.join(workspace, "3.1-outline.json"), "utf8").then(JSON.parse);
  const entries = collectOutlineEpisodes(outline).slice(0, 10);
  const units = [];

  entries.forEach((entry) => {
    const name = typeof entry.stage_name === "string" ? entry.stage_name.trim() : "";
    if (!name) throw new Error(`3.1-outline.json 的第 ${entry.episode} 集缺少剧情单元名称`);
    const current = units.at(-1);
    if (current?.["剧情单元名称"] === name) {
      current["集数"] += 1;
      return;
    }
    units.push({ "剧情单元名称": name, "集数": 1 });
  });

  return {
    "总剧情单元数": units.length,
    "总集数": entries.length,
    "剧情单元列表": units
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.episode && !args.unit) {
      const result = await getTrialUnitSummary(args.workspace);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const result = await getEpisodeInfo(args.workspace, args);
      process.stdout.write(`${JSON.stringify({ ok: true, message: "已读取当前写作范围的故事和角色信息。", ...result }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "get-episode-info", message: error.message, next_action: "检查集数、故事阶段名称和前置角色小传后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
