#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.join(agentRoot, "workspaces");

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--stage") {
    throw new Error("请使用 --workspace <项目目录> --stage <Skill 名称>");
  }
  return { workspace: argv[1], stage: argv[3] };
}

function strings(value) {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
}

function memoryPreferences(memory, stage) {
  const entries = memory?.preferences?.[stage];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [entry.trim()];
    if (entry && typeof entry === "object" && typeof entry.content === "string" && entry.content.trim()) {
      return [entry.content.trim()];
    }
    return [];
  });
}

function attachmentContexts(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment) => {
    const originalName = typeof attachment?.original_name === "string" ? attachment.original_name.trim() : "";
    const textPath = typeof attachment?.text_path === "string" ? attachment.text_path.trim() : "";
    if (attachment?.text_status !== "available" || !textPath) return [];
    return [{ original_name: originalName, text_path: textPath }];
  });
}

async function snapshotPreferenceContexts(stage) {
  const contextPath = process.env.ORCA_USER_PREFERENCE_CONTEXT_PATH?.trim();
  if (!contextPath) return [];
  const snapshot = await fs.readFile(path.resolve(contextPath), "utf8").then(JSON.parse).catch(() => null);
  if (!snapshot || snapshot.stage !== stage || !Array.isArray(snapshot.effective_preferences)) return [];
  return snapshot.effective_preferences.flatMap((preference) => {
    if (!preference || typeof preference !== "object" || typeof preference.content !== "string" || !preference.content.trim()) {
      return [];
    }
    return [preference.content.trim()];
  });
}

export async function getUserPreferences(workspace, stage) {
  const workspaceDir = path.resolve(agentRoot, workspace);
  if (!isInside(workspaceRoot, workspaceDir)) throw new Error("项目目录必须位于 workspaces/ 下");
  const [userInput, memory, snapshotPreferences] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "memory", "stage-preferences.json"), "utf8").then(JSON.parse).catch(() => ({ preferences: {} })),
    snapshotPreferenceContexts(stage)
  ]);
  const project = userInput.project || {};
  const preferences = [...new Set([
    ...strings(project.extra_requirements),
    ...strings(project.stage_preferences?.[stage]),
    ...memoryPreferences(memory, stage),
    ...snapshotPreferences
  ])];
  return {
    preferences,
    attachments: attachmentContexts(project.attachments)
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await getUserPreferences(args.workspace, args.stage);
    process.stdout.write(JSON.stringify({
      ok: true,
      message: "已读取当前步骤的用户要求、已启用的系统偏好与可用附件。",
      next_action: "如果有附件，先阅读相关附件，然后继续根据 Skill 的工作流程进行操作。",
      ...result
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      tool: "get-user-preferences",
      message: error.message,
      next_action: "检查项目目录、步骤名称和偏好记录后重试。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
