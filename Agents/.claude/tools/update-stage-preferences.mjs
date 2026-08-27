#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.join(agentRoot, "workspaces");
const STAGES = new Set(["project_init", "novel_analysis", "world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review", "humanizer_zh"]);

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
  for (const required of ["workspace", "stage", "content", "updated-by"]) {
    if (!args[required]?.trim()) throw new Error("缺少 --" + required + " 参数");
  }
  if (!STAGES.has(args.stage)) throw new Error("不支持的步骤：" + args.stage);
  return args;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function updateStagePreferences(args) {
  const workspaceDir = path.resolve(agentRoot, args.workspace);
  if (!isInside(workspaceRoot, workspaceDir)) throw new Error("项目目录必须位于 workspaces/ 下");
  const memoryPath = path.join(workspaceDir, "memory", "stage-preferences.json");
  const memory = await fs.readFile(memoryPath, "utf8").then(JSON.parse);
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) throw new Error("stage-preferences.json 结构无效");
  const now = new Date().toISOString();
  const item = {
    content: args.content.trim(),
    source: "manual_feedback",
    recorded_at: now,
    recorded_by: args["updated-by"]
  };
  memory.preferences = memory.preferences && typeof memory.preferences === "object" ? memory.preferences : {};
  memory.preferences[args.stage] = Array.isArray(memory.preferences[args.stage]) ? memory.preferences[args.stage] : [];
  memory.preferences[args.stage].push(item);
  memory.audit = { ...memory.audit, updated_at: now, updated_by: args["updated-by"] };
  await writeJson(memoryPath, memory);

  const stageMemoryPath = path.join(workspaceDir, "memory", args.stage + "_memory.json");
  const stageMemory = await fs.readFile(stageMemoryPath, "utf8").then(JSON.parse).catch(() => null);
  if (stageMemory && typeof stageMemory === "object" && !Array.isArray(stageMemory)) {
    stageMemory.user_feedback = Array.isArray(stageMemory.user_feedback) ? stageMemory.user_feedback : [];
    stageMemory.user_feedback.push(item);
    stageMemory.audit = { ...stageMemory.audit, updated_at: now, updated_by: args["updated-by"] };
    await writeJson(stageMemoryPath, stageMemory);
  }
  return { workspace_dir: workspaceDir, stage: args.stage, preference_count: memory.preferences[args.stage].length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await updateStagePreferences(args);
    process.stdout.write(JSON.stringify({
      ok: true,
      message: "已记录当前步骤的用户要求。",
      next_action: "重新读取用户偏好；若该步骤已通过，调用返修路由后再修改产物。",
      ...result
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      tool: "update-stage-preferences",
      message: error.message,
      next_action: "检查项目目录、步骤名称和要求内容后重试。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
