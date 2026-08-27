#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { resolveMaturityTarget } from "../../../tools/distribution-brief.mjs";
import { resetStageOutput } from "../../../tools/reset-stage-output.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workspaceRoot = path.join(agentRoot, "workspaces");
const SOURCE_FILE = "output/原始剧本.md";
const OUTPUT_FILE = "output/去AI味剧本.md";

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

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new Error(label + " 不存在或不是有效 JSON");
  }
}

export async function initializeHumanizerZh(args) {
  const workspaceDir = path.resolve(agentRoot, args.workspace);
  if (!isInside(workspaceRoot, workspaceDir)) throw new Error("项目目录必须位于 workspaces/ 下。");
  const [userInput, progress] = await Promise.all([
    readJson(path.join(workspaceDir, "1.1-user-input.json"), "1.1-user-input.json"),
    readJson(path.join(workspaceDir, "1.2-project-progress.json"), "1.2-project-progress.json")
  ]);
  if (progress.stages?.project_init?.status !== "completed") {
    throw new Error("project_init 尚未完成，无法处理原始剧本。");
  }
  if (userInput.project?.task_type && userInput.project.task_type !== "humanize") {
    throw new Error("当前项目不是剧本润色任务。");
  }

  const sourcePath = path.join(workspaceDir, SOURCE_FILE);
  const outputPath = path.join(workspaceDir, OUTPUT_FILE);
  const source = await fs.readFile(sourcePath, "utf8").catch(() => "");
  if (!source.trim()) throw new Error(SOURCE_FILE + " 不存在或内容为空。");
  if (process.env.ORCA_RESET_CURRENT_STAGE === "1") await resetStageOutput(workspaceDir, "humanizer_zh");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const outputExists = await fs.stat(outputPath).then((stat) => stat.isFile()).catch(() => false);
  if (!outputExists) await fs.writeFile(outputPath, source, "utf8");

  await updateProgress({
    workspace: workspaceDir,
    stage: "humanizer_zh",
    status: "in_progress",
    updatedBy: args["updated-by"].trim(),
    outputFiles: [OUTPUT_FILE]
  });
  return {
    workspace_dir: workspaceDir,
    source_file: SOURCE_FILE,
    output_file: OUTPUT_FILE,
    maturity_target: resolveMaturityTarget(userInput.project?.distribution_brief),
    reused_existing_output: outputExists
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await initializeHumanizerZh(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({
      ok: true,
      message: result.reused_existing_output ? "已保留已有润色剧本作为本次底稿。" : "已基于原始剧本准备润色剧本。",
      next_action: "逐集润色 output/去AI味剧本.md，保留故事事实和分集结构。",
      ...result
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      tool: "init-humanizer-zh",
      message: error.message,
      next_action: "确认项目已初始化且原始剧本存在后重试。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
