#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDistributionBriefComplete, resolveMaturityTarget } from "../../../tools/distribution-brief.mjs";
import { resetStageOutput } from "../../../tools/reset-stage-output.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { screenplayLengthContract } from "../../../tools/screenplay-length.mjs";
import { writeStageExecutionSpec } from "../../_shared/scripts/stage-execution-spec.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../references/trial.json5");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, argv[1]), updatedBy: argv[3] || "admin" };
}

export function parseTrialTemplate(text) {
  return JSON.parse(text.replace(/\/\/.*$/gmu, ""));
}

export function collectOutlineEpisodes(outline) {
  if (!outline || typeof outline !== "object" || Array.isArray(outline) || !Array.isArray(outline["剧情单元"])) {
    throw new Error("3.1-outline.json 缺少剧情单元");
  }
  const opening = outline["开篇"];
  if (!opening || typeof opening !== "object" || Array.isArray(opening) || !Array.isArray(opening["剧集"])) {
    throw new Error("3.1-outline.json 缺少开篇");
  }
  const entries = [];
  const addEpisodes = (episodes, stageName, stageDescription, stageRoles, sourceUnitIds = []) => {
    if (!Array.isArray(episodes)) throw new Error(`故事阶段“${stageName}”缺少剧集`);
    episodes.forEach((episode) => entries.push({
      episode: episode?.["集数"],
      stage_name: stageName,
      stage_description: stageDescription,
      stage_roles: Array.isArray(stageRoles) ? stageRoles : [],
      source_unit_ids: Array.isArray(sourceUnitIds) ? sourceUnitIds : [],
      episode_info: episode
    }));
  };
  addEpisodes(opening["剧集"], "开篇", opening["开篇描述"], opening["关键角色"], opening["原著剧情单元"]);
  outline["剧情单元"].forEach((unit) => addEpisodes(unit?.["剧集"], unit?.["单元名称"], unit?.["单元描述"], unit?.["关键角色"], unit?.["原著剧情单元"]));
  entries.forEach((entry, index) => {
    const expected = index + 1;
    if (!Number.isInteger(entry.episode) || entry.episode !== expected) {
      throw new Error(`3.1-outline.json 的剧集必须从 1 连续编号；第 ${expected} 集无效`);
    }
  });
  if (!entries.length) throw new Error("3.1-outline.json 未包含可生成的剧集");
  return entries;
}

export function episodeTitle(entry) {
  const title = typeof entry?.episode_info?.["剧集名称"] === "string"
    ? entry.episode_info["剧集名称"].trim()
    : "";
  if (!title) throw new Error(`3.1-outline.json 的第 ${entry?.episode || "?"} 集缺少剧集名称`);
  return title;
}

function renderScaffold(template, entries) {
  if (
    typeof template["文档标题"] !== "string"
    || typeof template["剧集标题"] !== "string"
    || !template["剧集标题"].includes("{集数}")
    || !template["剧集标题"].includes("{剧集名称}")
  ) {
    throw new Error("trial.json5 缺少文档标题或剧集标题");
  }
  const headings = entries.map((entry) => template["剧集标题"]
    .replace("{集数}", String(entry.episode))
    .replace("{剧集名称}", episodeTitle(entry)));
  return `${template["文档标题"]}\n\n${headings.join("\n\n")}\n`;
}

export async function initializeTrial(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [progress, userInput, outline, template] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "3.1-outline.json"), "utf8").then(JSON.parse),
    fs.readFile(templatePath, "utf8").then(parseTrialTemplate)
  ]);
  assertDistributionBriefComplete(userInput.project);
  const lengthContract = screenplayLengthContract(userInput);
  if (progress.stages?.character_rewrite?.status !== "completed") {
    throw new Error("character_rewrite 尚未完成");
  }
  if (process.env.ORCA_RESET_CURRENT_STAGE === "1") await resetStageOutput(workspaceDir, "trial_generate");
  const entries = collectOutlineEpisodes(outline).slice(0, 10);
  const outputPath = path.join(workspaceDir, "output", "剧本试稿.md");
  const existing = await fs.readFile(outputPath, "utf8").catch(() => "");
  if (!existing.trim()) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, renderScaffold(template, entries), "utf8");
  }
  await updateProgress({
    workspace: workspaceDir,
    stage: "trial_generate",
    status: "in_progress",
    updatedBy,
    outputFiles: ["output/剧本试稿.md"]
  });
  const executionSpec = await writeStageExecutionSpec({
    workspace: workspaceDir,
    stage: "trial_generate",
    userInput,
    outputFile: "output/剧本试稿.md",
    options: { jobId: process.env.ORCA_AGENT_JOB_ID }
  });
  return {
    workspace_dir: workspaceDir,
    output_file: outputPath,
    episode_range: [entries[0].episode, entries.at(-1).episode],
    task_type: userInput.project?.task_type || "rewrite",
    maturity_target: resolveMaturityTarget(userInput.project.distribution_brief),
    ...lengthContract,
    execution_spec_directory: executionSpec.paths.directory,
    execution_spec_file: executionSpec.paths.markdown
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await initializeTrial(args.workspace, args.updatedBy);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, message: `剧本试稿已初始化完成，请先阅读\`${result.execution_spec_file}\`，再按照 Skill 要求执行下一步。`, next_action: "请按照 Skill 步骤，继续执行下一步" }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "trial_generate", tool: "init", message: error.message, next_action: "修复角色小传或剧本大纲后重新初始化。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
