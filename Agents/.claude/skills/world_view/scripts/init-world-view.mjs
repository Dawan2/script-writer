#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDistributionBriefComplete, resolveMaturityTarget } from "../../../tools/distribution-brief.mjs";
import { pendingScriptProfileFields } from "../../../tools/script-profile.mjs";
import { resetStageOutput } from "../../../tools/reset-stage-output.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { writeStageExecutionSpec } from "../../_shared/scripts/stage-execution-spec.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../references/world-view.json5");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, argv[1]), updatedBy: argv[3] || "admin" };
}

function parseTemplate(text) {
  return JSON.parse(text.replace(/\/\/.*$/gmu, ""));
}

async function initializeMemory(workspaceDir, updatedBy) {
  const memoryPath = path.join(workspaceDir, "memory", "world_view_memory.json");
  const existing = await fs.readFile(memoryPath, "utf8").catch(() => "");
  if (existing.trim()) return memoryPath;
  const now = new Date().toISOString();
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, JSON.stringify({
    schema_version: "1.0.0",
    stage: "world_view",
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

export async function initializeWorldView(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [userInput, progress, template] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse),
    fs.readFile(templatePath, "utf8").then(parseTemplate)
  ]);
  if (!userInput.project?.target_region || !userInput.project?.source_script?.output_path) {
    throw new Error("项目输入缺少目标地区或源材料路径");
  }
  assertDistributionBriefComplete(userInput.project);
  if (progress.stages?.project_init?.status !== "completed") {
    throw new Error("project_init 尚未完成");
  }
  if (process.env.ORCA_RESET_CURRENT_STAGE === "1") await resetStageOutput(workspaceDir, "world_view");
  const outputPath = path.join(workspaceDir, "2.1-world-view.json");
  const existing = await fs.readFile(outputPath, "utf8").catch(() => "");
  if (!existing.trim()) {
    await fs.writeFile(outputPath, `${JSON.stringify({
      "世界观描述": template["世界观描述"],
      "关键概念映射": []
    }, null, 2)}\n`, "utf8");
  } else {
    JSON.parse(existing);
  }
  await initializeMemory(workspaceDir, updatedBy);
  await updateProgress({
    workspace: workspaceDir,
    stage: "world_view",
    status: "in_progress",
    updatedBy,
    outputFiles: ["2.1-world-view.json"]
  });
  const executionSpec = await writeStageExecutionSpec({
    workspace: workspaceDir,
    stage: "world_view",
    userInput,
    outputFile: "2.1-world-view.json",
    options: { jobId: process.env.ORCA_AGENT_JOB_ID }
  });
  return {
    workspace_dir: workspaceDir,
    execution_spec_directory: executionSpec.paths.directory,
    execution_spec_file: executionSpec.paths.markdown,
    world_view_file: outputPath,
    maturity_target: resolveMaturityTarget(userInput.project.distribution_brief),
    pending_script_profile_fields: pendingScriptProfileFields(userInput.project.distribution_brief)
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await initializeWorldView(args.workspace, args.updatedBy);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      workspace_dir: result.workspace_dir,
      execution_spec_directory: result.execution_spec_directory,
      execution_spec_file: result.execution_spec_file,
      message: `世界观已初始化完成，请先阅读\`${result.execution_spec_file}\`，再按照 Skill 要求执行下一步。请按照 Skill 步骤，继续执行下一步`,
      next_action: "请按照 Skill 步骤，继续执行下一步"
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "world_view", tool: "init", message: error.message, next_action: "修复前置项目状态后重新初始化。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
