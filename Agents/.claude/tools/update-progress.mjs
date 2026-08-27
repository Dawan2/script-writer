#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VALID_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "needs_revision",
  "awaiting_approval",
  "approved",
  "skipped"
]);
const APPROVAL_STAGES = new Set(["trial_generate", "foreign_review"]);
const FINISHED_STATUSES = new Set(["completed", "approved"]);

function parseArgs(argv) {
  const args = { output: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`无法识别参数：${key}`);
    const name = key.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`缺少 --${name} 的值`);
    if (name === "output") args.output.push(value);
    else if (args[name] !== undefined) throw new Error(`参数 --${name} 不能重复`);
    else args[name] = value;
    index += 1;
  }
  return args;
}

function actionableError(message, nextAction) {
  const error = new Error(message);
  error.nextAction = nextAction;
  return error;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw actionableError(`读不到这个项目的${label}，内容缺失或已损坏。`, "确认项目目录完整后重试，或重新创建项目。");
  }
}

async function missingOutputs(workspaceDir, outputs) {
  const checked = await Promise.all(outputs.map(async (relativePath) => ({
    relativePath,
    exists: await fs.stat(path.join(workspaceDir, relativePath)).then((stat) => stat.isFile()).catch(() => false)
  })));
  return checked.filter((item) => !item.exists).map((item) => item.relativePath);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeTitleConfirmation(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("剧本名称确认状态必须是对象");
  }
  const status = typeof value.status === "string" ? value.status.trim() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const englishTitle = typeof value.english_title === "string" ? value.english_title.trim() : "";
  if (!new Set(["pending", "confirmed"]).has(status) || !title) {
    throw new Error("剧本名称确认状态缺少有效的状态或剧本名称");
  }
  return { status, title, english_title: englishTitle };
}

function isMatchingConfirmedTitle(value, expected) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.status === "confirmed"
    && typeof value.title === "string"
    && value.title.trim() === expected.title
    && typeof value.english_title === "string"
    && value.english_title.trim() === expected.english_title
  );
}

export async function updateProgress({
  workspace,
  stage,
  status,
  updatedBy = "admin",
  nextSkill = "",
  outputFiles = [],
  allowApprovalState = false,
  titleConfirmation,
  preserveConfirmedTitleWhenUnchanged = false
}) {
  if (!stage) throw new Error("缺少 stage");
  if (!VALID_STATUSES.has(status)) throw new Error(`不支持的进度状态：${status}`);
  if (["awaiting_approval", "approved"].includes(status)
    && (!allowApprovalState || !APPROVAL_STAGES.has(stage))) {
    throw new Error("审批状态只能由对应的检查或批准工具更新");
  }
  const workspaceDir = path.resolve(workspace);
  const progressPath = path.join(workspaceDir, "1.2-project-progress.json");
  const userInputPath = path.join(workspaceDir, "1.1-user-input.json");
  const [progress, userInput] = await Promise.all([
    readJson(progressPath, "进度记录"),
    readJson(userInputPath, "项目信息")
  ]);
  const now = new Date().toISOString();
  const current = progress.stages?.[stage] || {};
  const outputs = outputFiles.length ? [...new Set(outputFiles)] : current.output_files || [];
  if (FINISHED_STATUSES.has(status)) {
    const missing = await missingOutputs(workspaceDir, outputs);
    if (!outputs.length || missing.length) {
      throw actionableError(
        `这一步的成果还没有落到项目里，缺少：${(missing.length ? missing : ["本步骤的成果文件"]).join("、")}。`,
        "先生成并保存这一步的成果，再把它标记为完成。"
      );
    }
  }
  const nextStage = { ...current, status, output_files: outputs, updated_at: now, updated_by: updatedBy };
  if (stage === "full_generate" && (
    status === "completed"
    || current.completed_once === true
    || ["completed", "approved", "stale"].includes(current.status)
  )) nextStage.completed_once = true;
  const normalizedTitleConfirmation = normalizeTitleConfirmation(titleConfirmation);
  if (normalizedTitleConfirmation !== undefined) {
    if (stage !== "outline_rewrite") throw new Error("剧本名称确认状态只能写入故事梗概步骤");
    nextStage.title_confirmation = preserveConfirmedTitleWhenUnchanged
      && isMatchingConfirmedTitle(current.title_confirmation, normalizedTitleConfirmation)
      ? { ...normalizedTitleConfirmation, status: "confirmed" }
      : normalizedTitleConfirmation;
  }
  progress.stages = { ...(progress.stages || {}) };
  progress.stages[stage] = nextStage;
  if (nextSkill && !progress.stages[nextSkill]) progress.stages[nextSkill] = { status: "pending" };
  progress.status = ["completed", "approved"].includes(status) && nextSkill
    ? "ready_for_next_skill"
    : `${stage}:${status}`;
  progress.current_skill = stage;
  progress.next_skill = nextSkill || "";
  progress.audit = { ...progress.audit, updated_at: now, updated_by: updatedBy };
  userInput.status = `${stage}:${status}`;
  userInput.audit = { ...userInput.audit, updated_at: now, updated_by: updatedBy };
  await Promise.all([writeJson(progressPath, progress), writeJson(userInputPath, userInput)]);
  return { workspace_dir: workspaceDir, stage, status, next_skill: progress.next_skill, output_files: outputs };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const field of ["workspace", "stage", "status", "updated-by"]) {
      if (args[field] === undefined) throw new Error(`缺少 --${field} 参数`);
    }
    const result = await updateProgress({
      workspace: args.workspace,
      stage: args.stage,
      status: args.status,
      updatedBy: args["updated-by"],
      nextSkill: args["next-skill"] || "",
      outputFiles: args.output
    });
    process.stdout.write(`${JSON.stringify({ ok: true, message: "项目进度已更新。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "update-progress", message: error.message, next_action: error.nextAction || "检查工作区、Skill 名称和状态后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
