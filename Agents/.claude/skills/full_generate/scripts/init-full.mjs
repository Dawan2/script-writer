#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDistributionBriefComplete, resolveMaturityTarget } from "../../../tools/distribution-brief.mjs";
import { resetStageOutput } from "../../../tools/reset-stage-output.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { fullScriptRelativePath, hasCompletedFullScript } from "../../../tools/script-artifacts.mjs";
import { screenplayLengthContract } from "../../../tools/screenplay-length.mjs";
import { writeStageExecutionSpec } from "../../_shared/scripts/stage-execution-spec.mjs";
import {
  assertEpisodeNumbers,
  collectOutlineStages,
  extractEpisodeSections,
  flattenEpisodes,
  getStageTasks,
  renderFullScript,
  renderStageScaffold,
  stageDirectory,
  stageFilePath,
  trialEpisodeCount
} from "./full-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, argv[1]), updatedBy: argv[3] || "admin" };
}

async function writeIfBlank(filePath, text) {
  const existing = await fs.readFile(filePath, "utf8").catch(() => "");
  if (existing.trim()) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  return true;
}

function executionContext(generationMode) {
  return {
    "执行模式": generationMode,
    "执行方式": generationMode === "full_revision"
      ? "直接修改已有完整剧本，不重建或比较试稿"
      : "保留已确认试稿，只完成试稿范围之后的剧集"
  };
}

export async function initializeFull(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [progress, userInput, outline] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "3.1-outline.json"), "utf8").then(JSON.parse)
  ]);
  assertDistributionBriefComplete(userInput.project);
  const lengthContract = screenplayLengthContract(userInput);
  const previousFull = progress.stages?.full_generate || {};
  const completedOnce = hasCompletedFullScript(userInput.project, previousFull);
  if (process.env.ORCA_RESET_CURRENT_STAGE === "1") await resetStageOutput(workspaceDir, "full_generate");
  const stages = collectOutlineStages(outline);
  const entries = flattenEpisodes(stages);
  const fullRelativePath = fullScriptRelativePath(outline);
  const fullPath = path.join(workspaceDir, fullRelativePath);
  if (completedOnce) {
    await writeIfBlank(fullPath, renderFullScript(entries.map((entry) => ({ episode: entry.episode })), outline));
    await updateProgress({
      workspace: workspaceDir,
      stage: "full_generate",
      status: "in_progress",
      updatedBy,
      outputFiles: [fullRelativePath]
    });
    const executionSpec = await writeStageExecutionSpec({
      workspace: workspaceDir,
      stage: "full_generate",
      userInput,
      outputFile: fullRelativePath,
      options: {
        jobId: process.env.ORCA_AGENT_JOB_ID,
        executionContext: executionContext("full_revision")
      }
    });
    return {
      workspace_dir: workspaceDir,
      output_file: fullPath,
      generation_mode: "full_revision",
      episode_range: [entries[0].episode, entries.at(-1).episode],
      stage_files: [],
      review_report_file: path.join(workspaceDir, "output", "审稿报告.md"),
      maturity_target: resolveMaturityTarget(userInput.project.distribution_brief),
      ...lengthContract,
      execution_spec_directory: executionSpec.paths.directory,
      execution_spec_file: executionSpec.paths.markdown
    };
  }
  if (progress.stages?.trial_generate?.status !== "approved") throw new Error("剧本试稿尚未获得用户确认");
  const trialText = await fs.readFile(path.join(workspaceDir, "output", "剧本试稿.md"), "utf8");
  const covered = trialEpisodeCount(stages);
  const trialEntries = entries.slice(0, covered);
  const trialSections = extractEpisodeSections(trialText);
  assertEpisodeNumbers(trialSections, trialEntries, "剧本试稿");
  await writeIfBlank(fullPath, renderFullScript([
    ...trialSections,
    ...entries.slice(covered).map((entry) => ({ episode: entry.episode }))
  ], outline));
  const tasks = getStageTasks(stages, covered);
  await fs.mkdir(stageDirectory(workspaceDir), { recursive: true });
  await Promise.all(tasks.map((stage) => writeIfBlank(stageFilePath(workspaceDir, stage), renderStageScaffold(stage))));
  await updateProgress({
    workspace: workspaceDir,
    stage: "full_generate",
    status: "in_progress",
    updatedBy,
    outputFiles: [fullRelativePath]
  });
  const executionSpec = await writeStageExecutionSpec({
    workspace: workspaceDir,
    stage: "full_generate",
    userInput,
    outputFile: fullRelativePath,
    options: {
      jobId: process.env.ORCA_AGENT_JOB_ID,
      executionContext: executionContext("trial_continuation")
    }
  });
  return {
    workspace_dir: workspaceDir,
    output_file: fullPath,
    generation_mode: "trial_continuation",
    trial_episode_range: [trialEntries[0].episode, trialEntries.at(-1).episode],
    stage_files: tasks.map((stage) => path.relative(workspaceDir, stageFilePath(workspaceDir, stage))),
    maturity_target: resolveMaturityTarget(userInput.project.distribution_brief),
    ...lengthContract,
    execution_spec_directory: executionSpec.paths.directory,
    execution_spec_file: executionSpec.paths.markdown
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await initializeFull(args.workspace, args.updatedBy);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, message: `剧本全稿已初始化完成，请先阅读\`${result.execution_spec_file}\`，再按照 Skill 要求执行下一步。`, next_action: "请按照 Skill 步骤，继续执行下一步" }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "full_generate", tool: "init", message: error.message, next_action: "检查完整剧本、剧本大纲及首次生成所需的已确认试稿后重新初始化。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
