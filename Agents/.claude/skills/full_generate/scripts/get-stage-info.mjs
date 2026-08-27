#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectOutlineStages, getStageTasks, roleNames, stageFilePath } from "./full-utils.mjs";
import { fullScriptRelativePath, hasCompletedFullScript } from "../../../tools/script-artifacts.mjs";
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
  const allowedArgs = new Set(["workspace", "unit", "episode"]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`无法识别参数：${key}`);
    const name = key.slice(2);
    if (!allowedArgs.has(name)) throw new Error(`无法识别参数：--${name}`);
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
  if (args.unit !== undefined && !args.unit.trim()) throw new Error("--unit 不能为空");
  return { workspace, episode: args.episode ? Number(args.episode) : null, unit: args.unit?.trim() || "" };
}

function summarizeStage(stage) {
  if (!stage) return null;
  return {
    name: stage.name,
    description: stage.description,
    key_roles: stage.key_roles,
    episodes: stage.episodes
  };
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

function normalizeQuery(query) {
  const options = typeof query === "string" ? { unit: query } : query || {};
  const episode = options.episode ?? null;
  const unit = typeof options.unit === "string" ? options.unit.trim() : "";
  if ((episode === null && !unit) || (episode !== null && unit)) throw new Error("只能查询一个剧情单元或一集");
  if (episode !== null && (!Number.isInteger(episode) || episode < 1)) throw new Error("集数必须是正整数");
  return { episode, unit };
}

export async function getStageInfo(workspace, query) {
  const { episode, unit } = normalizeQuery(query);
  const [outline, characters, userInput, progress] = await Promise.all([
    fs.readFile(path.join(workspace, "3.1-outline.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspace, "4.1-character.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8").then(JSON.parse).catch((error) => {
      if (error?.code === "ENOENT") return { project: { task_type: "rewrite" } };
      throw error;
    }),
    fs.readFile(path.join(workspace, "1.2-project-progress.json"), "utf8").then(JSON.parse).catch((error) => {
      if (error?.code === "ENOENT") return { stages: {} };
      throw error;
    })
  ]);
  if (!Array.isArray(characters)) throw new Error("4.1-character.json 顶层必须是数组");
  const stages = collectOutlineStages(outline);
  const fullProgress = progress.stages?.full_generate || {};
  const fullRevision = hasCompletedFullScript(userInput.project, fullProgress);
  const writableStages = fullRevision ? stages : getStageTasks(stages);
  const matchedStage = episode
    ? writableStages.find((stage) => stage.episodes.some((item) => item?.["集数"] === episode))
    : writableStages.find((stage) => stage.name === unit);
  if (!matchedStage) {
    throw new Error(episode ? `未找到可续写的第 ${episode} 集` : `未找到可续写的故事阶段：${unit}`);
  }
  const task = episode
    ? { ...matchedStage, episodes: matchedStage.episodes.filter((item) => item?.["集数"] === episode) }
    : matchedStage;
  const currentIndex = stages.findIndex((stage) => stage.stage_index === task.stage_index);
  const names = roleNames(task);
  const englishNames = englishNameByChineseName(outline);
  const unmappedNames = [...names].filter((name) => !englishNames.has(name));
  if (unmappedNames.length) {
    throw new Error(`3.1-outline.json 的关键角色名称映射缺少中文名称：${unmappedNames.join("、")}`);
  }
  const taskType = userInput.project?.task_type || "rewrite";
  const novelAnalysis = taskType === "novel" ? await readNovelAnalysis(workspace) : null;
  const sourceHighlights = novelAnalysis ? sourceUnitsForReferences(novelAnalysis, task.source_unit_ids) : [];
  return {
    task_type: taskType,
    maturity_target: resolveMaturityTarget(userInput.project?.distribution_brief),
    previous_stage: summarizeStage(stages[currentIndex - 1]),
    current_stage: summarizeStage(task),
    next_stage: summarizeStage(stages[currentIndex + 1]),
    source_highlights: sourceHighlights,
    characters: characters
      .filter((character) => names.has(character?.["人物名称"]))
      .map((character) => currentStageCharacter(character, task.name)),
    generation_mode: fullRevision ? "full_revision" : "trial_continuation",
    stage_script_file: fullRevision
      ? fullScriptRelativePath(outline)
      : path.relative(workspace, stageFilePath(workspace, task))
  };
}

export async function getFullUnitSummary(workspace) {
  const outline = await fs.readFile(path.join(workspace, "3.1-outline.json"), "utf8").then(JSON.parse);
  const stages = collectOutlineStages(outline);
  return {
    "总剧情单元数": stages.length,
    "总集数": stages.reduce((total, stage) => total + stage.episodes.length, 0),
    "剧情单元列表": stages.map((stage) => ({
      "剧情单元名称": stage.name,
      "集数": stage.episodes.length
    }))
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.episode && !args.unit) {
      const result = await getFullUnitSummary(args.workspace);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const result = await getStageInfo(args.workspace, args);
      process.stdout.write(`${JSON.stringify({ ok: true, message: "已读取当前故事阶段及其前后承接信息。", next_action: result.source_highlights.length ? "先按 source_index 调用小说原文读取工具，再写 current_stage。" : "只写 current_stage 中的剧集到 stage_script_file。", ...result }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "get-stage-info", message: error.message, next_action: "检查单元名称、剧本大纲和角色小传后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
