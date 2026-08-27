#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateProgress } from "../../../tools/update-progress.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workspaceRoot = path.join(agentRoot, "workspaces");
const SOURCE_FILE = "output/原始剧本.md";
const OUTPUT_FILE = "output/去AI味剧本.md";
const EPISODE_HEADING_RE = /^#{1,6}\s*(?:第\s*\d+\s*[集章]|(?:EP(?:ISODE)?)[ ._-]*\d+)[^\n]*$/gimu;
const DELIVERY_META_PATTERNS = [
  /(?:以下|下面)是.{0,24}(?:润色|优化|去\s*AI).{0,24}(?:文本|版本|剧本)/u,
  /(?:修改说明|润色说明|优化说明|去\s*AI\s*说明)/u,
  /(?:已完成|已经完成).{0,24}(?:去\s*AI|润色|优化).{0,24}(?:处理|工作|任务)/u
];

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
  for (const field of ["workspace", "updated-by"]) {
    if (!args[field]?.trim()) throw new Error("缺少 --" + field + " 参数");
  }
  return args;
}

function episodeHeadings(content) {
  return (content.match(EPISODE_HEADING_RE) || []).map((heading) => heading.replace(/\s+/gu, " ").trim());
}

function errorsFor(source, output) {
  const errors = [];
  if (!output.trim()) errors.push(OUTPUT_FILE + " 不存在或内容为空。");
  const sourceHeadings = episodeHeadings(source);
  const outputHeadings = episodeHeadings(output);
  if (sourceHeadings.length && JSON.stringify(sourceHeadings) !== JSON.stringify(outputHeadings)) {
    errors.push("润色剧本必须保留原始剧本的分集标题及顺序。");
  }
  if (DELIVERY_META_PATTERNS.some((pattern) => pattern.test(output))) {
    errors.push("润色剧本包含交付元话语，请只保留可拍剧本正文。");
  }
  return errors;
}

export async function checkHumanizerZh(args) {
  const workspaceDir = path.resolve(agentRoot, args.workspace);
  if (!isInside(workspaceRoot, workspaceDir)) throw new Error("项目目录必须位于 workspaces/ 下。");
  const [source, output] = await Promise.all([
    fs.readFile(path.join(workspaceDir, SOURCE_FILE), "utf8").catch(() => ""),
    fs.readFile(path.join(workspaceDir, OUTPUT_FILE), "utf8").catch(() => "")
  ]);
  if (!source.trim()) throw new Error(SOURCE_FILE + " 不存在或内容为空。");
  const errors = errorsFor(source, output);
  if (errors.length) {
    throw new Error(errors.join("；"));
  }
  await updateProgress({
    workspace: workspaceDir,
    stage: "humanizer_zh",
    status: "completed",
    updatedBy: args["updated-by"].trim(),
    outputFiles: [OUTPUT_FILE]
  });
  return { workspace_dir: workspaceDir, output_file: OUTPUT_FILE, episode_count: episodeHeadings(source).length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkHumanizerZh(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({
      ok: true,
      message: "润色剧本已通过文件与结构检查。",
      next_action: "可以交付或继续按用户要求调整。",
      ...result
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      tool: "check-humanizer-zh",
      message: error.message,
      next_action: "仅修复返回的结构或交付问题后重新检查。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
