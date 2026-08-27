#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDistributionBriefComplete, resolveMaturityTarget } from "../../../tools/distribution-brief.mjs";
import { resetStageOutput } from "../../../tools/reset-stage-output.mjs";
import { projectScriptTitle, shouldRenameScriptTitle } from "../../../tools/script-artifacts.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { deriveNovelOutlinePlan } from "../../novel_analysis/scripts/novel-analysis-utils.mjs";
import { writeStageExecutionSpec } from "../../_shared/scripts/stage-execution-spec.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../references/outline.json5");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, argv[1]), updatedBy: argv[3] || "admin" };
}

function parseTemplate(text) {
  return JSON.parse(text.replace(/\/\/.*$/gmu, ""));
}

function createOpening(template) {
  const opening = structuredClone(template["开篇"]);
  opening["关键角色"] = [];
  opening["剧集"] = [structuredClone(template["开篇"]["剧集"][0])];
  opening["剧集"][0]["集数"] = 1;
  opening["剧集"][0]["关键角色"] = [];
  opening["剧集"][0]["写作思路"]["主要转折"] = [];
  return opening;
}

async function initializeMemory(workspaceDir, updatedBy) {
  const memoryPath = path.join(workspaceDir, "memory", "outline_rewrite_memory.json");
  const existing = await fs.readFile(memoryPath, "utf8").catch(() => "");
  if (existing.trim()) return memoryPath;
  const now = new Date().toISOString();
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, JSON.stringify({
    schema_version: "1.0.0",
    stage: "outline_rewrite",
    user_feedback: [],
    audit: {
      created_at: now,
      created_by: updatedBy,
      updated_at: now,
      updated_by: updatedBy
    }
  }, null, 2) + "\n", "utf8");
  return memoryPath;
}

export async function initializeOutline(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [userInput, progress, template] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse),
    fs.readFile(templatePath, "utf8").then(parseTemplate)
  ]);
  if (!userInput.project?.source_script?.output_path || !userInput.project?.target_region) {
    throw new Error("项目输入缺少原始内容路径或目标地区");
  }
  assertDistributionBriefComplete(userInput.project);
  const taskType = userInput.project?.task_type || "rewrite";
  const renameTitle = shouldRenameScriptTitle(userInput.project);
  const adaptationPlan = taskType === "novel" ? deriveNovelOutlinePlan(userInput.project) : null;
  const contextStage = taskType === "novel" ? "novel_analysis" : "world_view";
  if (progress.stages?.[contextStage]?.status !== "completed") {
    throw new Error(`${contextStage} 尚未完成`);
  }
  const contextRelativePath = taskType === "novel" ? "2.1-novel-analysis.json" : "2.1-world-view.json";
  const contextPath = path.join(workspaceDir, contextRelativePath);
  const context = await fs.readFile(contextPath, "utf8").then(JSON.parse).catch(() => null);
  if (!context) throw new Error(`${contextRelativePath} 不存在或不是有效 JSON`);
  if (process.env.ORCA_RESET_CURRENT_STAGE === "1") await resetStageOutput(workspaceDir, "outline_rewrite");
  const outputPath = path.join(workspaceDir, "3.1-outline.json");
  const existing = await fs.readFile(outputPath, "utf8").catch(() => "");
  if (!existing.trim()) {
    const title = renameTitle ? template["剧本名称"] : projectScriptTitle(userInput.project);
    if (!renameTitle && !title) throw new Error("非剧本改写项目缺少项目名称");
    await fs.writeFile(outputPath, `${JSON.stringify({
      "剧本名称": title,
      "英文剧本名称": renameTitle ? template["英文剧本名称"] : "",
      "关键角色名称映射": [],
      "故事梗概": template["故事梗概"],
      "开篇": createOpening(template),
      "剧情单元": []
    }, null, 2)}\n`, "utf8");
  } else {
    JSON.parse(existing);
  }
  await initializeMemory(workspaceDir, updatedBy);
  await updateProgress({
    workspace: workspaceDir,
    stage: "outline_rewrite",
    status: "in_progress",
    updatedBy,
    outputFiles: ["3.1-outline.json"]
  });
  const executionSpec = await writeStageExecutionSpec({
    workspace: workspaceDir,
    stage: "outline_rewrite",
    userInput,
    outputFile: "3.1-outline.json",
    options: { jobId: process.env.ORCA_AGENT_JOB_ID }
  });
  return {
    workspace_dir: workspaceDir,
    outline_file: outputPath,
    task_type: taskType,
    maturity_target: resolveMaturityTarget(userInput.project.distribution_brief),
    ...(taskType === "rewrite" ? { adaptation_context_file: contextPath } : {}),
    ...(adaptationPlan ? { adaptation_plan: adaptationPlan } : {}),
    execution_spec_directory: executionSpec.paths.directory,
    execution_spec_file: executionSpec.paths.markdown
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await initializeOutline(args.workspace, args.updatedBy);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, message: `剧本大纲已初始化完成，请先阅读\`${result.execution_spec_file}\`，再按照 Skill 要求执行下一步。`, next_action: "请按照 Skill 步骤，继续执行下一步" }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "outline_rewrite", tool: "init", message: error.message, next_action: "修复前置改编资料或项目输入后重新初始化。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
