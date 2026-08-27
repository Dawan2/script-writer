#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateProgress } from "./update-progress.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.join(agentRoot, "workspaces");
const APPROVAL_FLOW = {
  trial_generate: "full_generate",
  foreign_review: ""
};

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
  for (const required of ["workspace", "stage", "approved-by"]) {
    if (!args[required]) throw new Error("缺少 --" + required + " 参数");
  }
  if (!Object.hasOwn(APPROVAL_FLOW, args.stage)) {
    throw new Error("只有剧本试稿和审稿报告可以在此确认。");
  }
  return args;
}

export async function approveStage(workspace, stage, approvedBy = "admin") {
  const workspaceDir = path.resolve(agentRoot, workspace);
  if (!isInside(workspaceRoot, workspaceDir)) throw new Error("项目目录必须位于 workspaces/ 下。");
  const progress = JSON.parse(await fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8"));
  const state = progress.stages?.[stage]?.status;
  if (state !== "awaiting_approval") {
    throw new Error(stage + " 当前不是待确认状态，不能批准。");
  }
  const nextSkill = APPROVAL_FLOW[stage];
  const result = await updateProgress({
    workspace: workspaceDir,
    stage,
    status: "approved",
    allowApprovalState: true,
    updatedBy: approvedBy,
    nextSkill,
    outputFiles: progress.stages?.[stage]?.output_files || []
  });
  return { ...result, final: !nextSkill };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await approveStage(args.workspace, args.stage, args["approved-by"]);
    process.stdout.write(JSON.stringify({
      ok: true,
      message: result.final ? "审稿报告已确认，项目已完成。" : "剧本试稿已确认。",
      next_action: result.final ? "按审稿报告进入发行或人工复核。" : "可以执行 full_generate。",
      ...result
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      tool: "approve-stage",
      message: error.message,
      next_action: "确认当前阶段已通过检查并处于待确认状态后重试。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
