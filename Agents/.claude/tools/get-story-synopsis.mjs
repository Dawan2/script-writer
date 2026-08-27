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
  if (argv.length !== 2 || argv[0] !== "--workspace") throw new Error("请使用 --workspace <项目目录>");
  const workspace = path.resolve(agentRoot, argv[1]);
  if (!isInside(workspaceRoot, workspace)) throw new Error("项目目录必须位于 workspaces/ 下");
  return workspace;
}

export async function getStorySynopsis(workspace) {
  const outline = JSON.parse(await fs.readFile(path.join(workspace, "3.1-outline.json"), "utf8"));
  const scriptName = typeof outline["剧本名称"] === "string" ? outline["剧本名称"].trim() : "";
  const synopsis = typeof outline["故事梗概"] === "string" ? outline["故事梗概"].trim() : "";
  if (!scriptName) throw new Error("3.1-outline.json 缺少剧本名称");
  if (!synopsis) throw new Error("3.1-outline.json 缺少故事梗概");
  return { script_name: scriptName, story_synopsis: synopsis };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspace = parseArgs(process.argv.slice(2));
    const result = await getStorySynopsis(workspace);
    process.stdout.write(`${JSON.stringify({ ok: true, message: "已读取故事梗概。", next_action: "将其用于理解当前内容在全剧中的位置，不要写入剧本正文。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "get-story-synopsis", message: error.message, next_action: "检查项目目录和剧本大纲后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
