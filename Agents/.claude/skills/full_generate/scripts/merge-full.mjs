#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertEpisodeNumbers,
  collectOutlineStages,
  extractEpisodeSections,
  flattenEpisodes,
  getStageTasks,
  renderFullScript,
  stageFilePath,
  trialEpisodeCount
} from "./full-utils.mjs";
import { assertDistributionBriefComplete } from "../../../tools/distribution-brief.mjs";
import { fullScriptRelativePath, hasCompletedFullScript } from "../../../tools/script-artifacts.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") throw new Error("请使用 --workspace <项目目录>");
  return path.resolve(agentRoot, argv[1]);
}

export async function mergeFullScript(workspace) {
  const workspaceDir = path.resolve(workspace);
  const trialPath = path.join(workspaceDir, "output", "剧本试稿.md");
  const [progress, userInput, outline] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "3.1-outline.json"), "utf8").then(JSON.parse)
  ]);
  assertDistributionBriefComplete(userInput.project);
  const fullRelativePath = fullScriptRelativePath(outline);
  const formatRepairs = [];
  const stages = collectOutlineStages(outline);
  const entries = flattenEpisodes(stages);
  const fullProgress = progress.stages?.full_generate || {};
  const fullRevision = hasCompletedFullScript(userInput.project, fullProgress);
  if (fullRevision) {
    const outputPath = path.join(workspaceDir, fullRelativePath);
    const fullText = await fs.readFile(outputPath, "utf8");
    const fullSections = extractEpisodeSections(fullText);
    assertEpisodeNumbers(fullSections, entries, "剧本全稿");
    await fs.writeFile(outputPath, renderFullScript(fullSections, outline), "utf8");
    return {
      output_file: outputPath,
      generation_mode: "full_revision",
      episode_range: [entries[0].episode, entries.at(-1).episode],
      format_repairs: formatRepairs
    };
  }
  if (progress.stages?.trial_generate?.status !== "approved") throw new Error("剧本试稿尚未获得用户确认");
  const trialSourceText = await fs.readFile(trialPath, "utf8");
  const covered = trialEpisodeCount(stages);
  const trialEntries = entries.slice(0, covered);
  const trialSections = extractEpisodeSections(trialSourceText);
  assertEpisodeNumbers(trialSections, trialEntries, "剧本试稿");
  const stageSections = [];
  for (const stage of getStageTasks(stages, covered)) {
    const sourcePath = stageFilePath(workspaceDir, stage);
    const sourceText = await fs.readFile(sourcePath, "utf8");
    const sections = extractEpisodeSections(sourceText);
    assertEpisodeNumbers(sections, stage.episodes, `故事阶段“${stage.name}”`);
    stageSections.push(...sections);
  }
  const sections = [...trialSections, ...stageSections].sort((left, right) => left.episode - right.episode);
  assertEpisodeNumbers(sections, entries, "合并后的剧本全稿");
  const outputPath = path.join(workspaceDir, fullRelativePath);
  await fs.writeFile(outputPath, renderFullScript(sections, outline), "utf8");
  return {
    output_file: outputPath,
    episode_range: [entries[0].episode, entries.at(-1).episode],
    format_repairs: formatRepairs
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspace = parseArgs(process.argv.slice(2));
    const result = await mergeFullScript(workspace);
    process.stdout.write(`${JSON.stringify({ ok: true, message: "已合并剧本全稿。", next_action: "整体回读后运行格式检查。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "merge-full", message: error.message, next_action: "补齐当前模式要求的完整剧本或阶段文件后重新合并。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
