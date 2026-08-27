#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_NOVEL_ANALYSIS_CHARACTERS,
  novelAnalysisLengthLimitMessage,
  novelSourceRelativePath,
  readNovelSourceStats,
  readProjectFiles
} from "./novel-analysis-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") {
    throw new Error("请使用 --workspace <项目目录>");
  }
  return path.resolve(agentRoot, argv[1]);
}

export async function checkNovelLength(workspace) {
  const workspaceDir = path.resolve(workspace);
  const { userInput } = await readProjectFiles(workspaceDir);
  if (userInput.project?.task_type !== "novel") throw new Error("当前项目不是小说改编场景");
  const sourceRelativePath = novelSourceRelativePath(userInput);
  const stats = await readNovelSourceStats(workspaceDir, sourceRelativePath);
  const allowed = stats.character_count <= MAX_NOVEL_ANALYSIS_CHARACTERS;
  return {
    allowed,
    character_count: stats.character_count,
    message: allowed
      ? "小说字数符合解析范围。"
      : novelAnalysisLengthLimitMessage(stats.character_count)
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkNovelLength(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, message: error.message })}\n`);
    process.exitCode = 1;
  }
}
