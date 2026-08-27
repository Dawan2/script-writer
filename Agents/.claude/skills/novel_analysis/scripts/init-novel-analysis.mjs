#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDistributionBriefComplete, resolveMaturityTarget } from "../../../tools/distribution-brief.mjs";
import { pendingScriptProfileFields } from "../../../tools/script-profile.mjs";
import { resetStageOutput } from "../../../tools/reset-stage-output.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import {
  ANALYSIS_RELATIVE_PATH,
  assertNovelAnalysisLengthAllowed,
  buildNovelSourceIndex,
  deriveNovelOutlinePlan,
  novelSourceRelativePath,
  readNovelSourceStats,
  readProjectFiles
} from "./novel-analysis-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, argv[1]), updatedBy: argv[3] || "admin" };
}

function emptyAnalysis() {
  return {
    "基础信息": {
      "小说名称": "",
      "小说梗概": "",
      "题材": [],
      "基调": ""
    },
    "核心卖点": "",
    "故事主线": "",
    "世界观": "",
    "关键人物": [],
    "剧情单元": []
  };
}

async function initializeMemory(workspace, updatedBy) {
  const memoryPath = path.join(workspace, "memory", "novel_analysis_memory.json");
  const existing = await fs.readFile(memoryPath, "utf8").catch(() => "");
  if (existing.trim()) return;
  const now = new Date().toISOString();
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, `${JSON.stringify({
    schema_version: "1.0.0",
    stage: "novel_analysis",
    user_feedback: [],
    audit: { created_at: now, created_by: updatedBy, updated_at: now, updated_by: updatedBy }
  }, null, 2)}\n`, "utf8");
}

export async function initializeNovelAnalysis(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const { userInput, progress } = await readProjectFiles(workspaceDir);
  if (userInput.project?.task_type !== "novel") throw new Error("当前项目不是小说改编场景");
  assertDistributionBriefComplete(userInput.project);
  if (progress.stages?.project_init?.status !== "completed") throw new Error("project_init 尚未完成");
  if (process.env.ORCA_RESET_CURRENT_STAGE === "1") await resetStageOutput(workspaceDir, "novel_analysis");
  const adaptationPlan = deriveNovelOutlinePlan(userInput.project);
  const sourceRelativePath = novelSourceRelativePath(userInput);
  const sourceStats = await readNovelSourceStats(workspaceDir, sourceRelativePath);
  assertNovelAnalysisLengthAllowed(sourceStats);
  const index = await buildNovelSourceIndex(workspaceDir, sourceRelativePath);
  const outputPath = path.join(workspaceDir, ANALYSIS_RELATIVE_PATH);
  const existing = await fs.readFile(outputPath, "utf8").catch(() => "");
  if (!existing.trim()) {
    await fs.writeFile(outputPath, `${JSON.stringify(emptyAnalysis(), null, 2)}\n`, "utf8");
  } else {
    JSON.parse(existing);
  }
  await initializeMemory(workspaceDir, updatedBy);
  await updateProgress({
    workspace: workspaceDir,
    stage: "novel_analysis",
    status: "in_progress",
    updatedBy,
    outputFiles: [ANALYSIS_RELATIVE_PATH, "runtime/novel-source-index.json"]
  });
  return {
    workspace_dir: workspaceDir,
    analysis_file: outputPath,
    source_index: index,
    maturity_target: resolveMaturityTarget(userInput.project.distribution_brief),
    script_profile: {
      theme: userInput.project.distribution_brief.theme,
      setting: userInput.project.distribution_brief.setting,
      background: userInput.project.distribution_brief.background,
      audience: userInput.project.distribution_brief.audience
    },
    pending_script_profile_fields: pendingScriptProfileFields(userInput.project.distribution_brief),
    adaptation_plan: adaptationPlan
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await initializeNovelAnalysis(args.workspace, args.updatedBy);
    process.stdout.write(`${JSON.stringify({ ok: true, message: "小说解读已准备完成。", next_action: "调用‘完整阅读小说’工具；根据工具返回结果继续后续复核。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "novel_analysis", tool: "init", message: error.message, next_action: "检查小说文件、任务类型和项目初始化状态后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
