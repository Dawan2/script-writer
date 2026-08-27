#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRegionRules } from "./get-region-rules.mjs";
import { hasCompletedFullScript } from "./script-artifacts.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.join(agentRoot, "workspaces");
export const STAGE_ORDER = Object.freeze([
  "project_init",
  "world_view",
  "outline_rewrite",
  "character_rewrite",
  "trial_generate",
  "full_generate",
  "dialogue_translate",
  "foreign_review"
]);
const HUMANIZE_STAGE_ORDER = Object.freeze(["project_init", "humanizer_zh"]);
const NOVEL_STAGE_ORDER = Object.freeze([
  "project_init",
  "novel_analysis",
  "outline_rewrite",
  "character_rewrite",
  "trial_generate",
  "full_generate",
  "dialogue_translate",
  "foreign_review"
]);
const SUPPORTED_STAGES = new Set([...STAGE_ORDER, ...NOVEL_STAGE_ORDER, "humanizer_zh"]);

async function stageOrderForProject(project) {
  const taskType = project?.task_type;
  if (taskType === "humanize") return HUMANIZE_STAGE_ORDER;
  const base = taskType === "novel" ? NOVEL_STAGE_ORDER : STAGE_ORDER;
  if (!["rewrite", "novel", "replicate"].includes(taskType)) return base;
  const region = await resolveRegionRules(project?.target_region);
  return region.requires_translation ? base : base.filter((stage) => stage !== "dialogue_translate");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error("无法识别参数：" + key);
    const name = key.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || args[name] !== undefined) {
      throw new Error("参数 --" + name + " 无效或重复");
    }
    args[name] = value;
    index += 1;
  }
  for (const required of ["workspace", "stage", "reason", "updated-by"]) {
    if (!args[required]?.trim()) throw new Error("缺少 --" + required + " 参数");
  }
  if (!SUPPORTED_STAGES.has(args.stage)) throw new Error("不支持的返修步骤：" + args.stage);
  return args;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function routeRevision({
  workspace,
  stage,
  reason,
  updatedBy = "admin"
}) {
  const workspaceDir = path.resolve(agentRoot, workspace);
  if (!isInside(workspaceRoot, workspaceDir)) throw new Error("项目目录必须位于 workspaces/ 下。");
  const [progress, userInput] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse)
  ]);
  const stageOrder = await stageOrderForProject(userInput.project);
  if (!stageOrder.includes(stage)) throw new Error("当前任务不支持返修步骤：" + stage);
  const stageIndex = stageOrder.indexOf(stage);
  const now = new Date().toISOString();
  progress.stages = { ...(progress.stages || {}) };
  const current = progress.stages[stage] || {};
  progress.stages[stage] = {
    ...current,
    status: "needs_revision",
    ...(stage === "full_generate" && hasCompletedFullScript(userInput.project, current)
      ? { completed_once: true }
      : {}),
    revision_reason: reason.trim(),
    updated_at: now,
    updated_by: updatedBy
  };
  delete progress.stages[stage].last_error;
  const invalidatedStages = [];
  stageOrder.slice(stageIndex + 1).forEach((downstream) => {
    const previous = progress.stages[downstream] || {};
    if (previous.status !== "pending") invalidatedStages.push(downstream);
    progress.stages[downstream] = {
      ...previous,
      status: "pending",
      ...(downstream === "full_generate" && hasCompletedFullScript(userInput.project, previous)
        ? { completed_once: true }
        : {}),
      invalidated_by: stage,
      updated_at: now,
      updated_by: updatedBy
    };
    delete progress.stages[downstream].last_error;
  });
  progress.status = stage + ":needs_revision";
  progress.current_skill = stage;
  progress.next_skill = stage;
  progress.audit = { ...progress.audit, updated_at: now, updated_by: updatedBy };
  userInput.status = stage + ":needs_revision";
  userInput.audit = { ...userInput.audit, updated_at: now, updated_by: updatedBy };
  await Promise.all([
    writeJson(path.join(workspaceDir, "1.2-project-progress.json"), progress),
    writeJson(path.join(workspaceDir, "1.1-user-input.json"), userInput)
  ]);
  return {
    workspace_dir: workspaceDir,
    revision_stage: stage,
    invalidated_stages: invalidatedStages,
    next_skill: stage
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await routeRevision({
      workspace: args.workspace,
      stage: args.stage,
      reason: args.reason,
      updatedBy: args["updated-by"]
    });
    process.stdout.write(JSON.stringify({
      ok: true,
      message: "已回到最早需要返修的阶段。",
      next_action: "按照 Skill 的工作流程，继续下一个步骤。",
      ...result
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      tool: "route-revision",
      message: error.message,
      next_action: "检查项目目录、返修阶段和返修原因后重试。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
