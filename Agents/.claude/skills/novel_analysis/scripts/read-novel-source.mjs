#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HIGHLIGHT_INDEX_RE, INDEX_RELATIVE_PATH, resolveWorkspaceFile } from "./novel-analysis-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workspaceRoot = path.join(agentRoot, "workspaces");
const MAX_DISPLAYED_READ_LINES = 1200;
const INCLUSIVE_RANGE_TOLERANCE = 1;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]] = argv[index + 1];
  const modes = ["--chapter", "--range", "--index"].filter((key) => args[key]);
  if (!args["--workspace"] || modes.length !== 1) throw new Error("请传入工作区，并且只使用 --chapter、--range 或 --index 之一");
  const workspace = path.resolve(agentRoot, args["--workspace"]);
  const relative = path.relative(workspaceRoot, workspace);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("项目目录必须位于 workspaces/ 下");
  return { workspace, mode: modes[0], value: args[modes[0]] };
}

function numericRange(value) {
  const match = /^(\d+)-(\d+)$/u.exec(value || "");
  if (!match) throw new Error("行号范围格式应为 起始行-结束行");
  return [Number(match[1]), Number(match[2])];
}

export async function readNovelSource(workspace, { chapter, range, sourceIndex } = {}) {
  const index = await fs.readFile(path.join(workspace, INDEX_RELATIVE_PATH), "utf8").then(JSON.parse);
  let startLine;
  let endLine;
  if (chapter !== undefined) {
    const number = Number(chapter);
    const target = index.chapters?.find((item) => item.index === number);
    if (!target) throw new Error(`未找到第 ${chapter} 个章节索引`);
    ({ start_line: startLine, end_line: endLine } = target);
  } else if (sourceIndex) {
    const match = HIGHLIGHT_INDEX_RE.exec(sourceIndex);
    if (!match) throw new Error("高光原文索引格式应为 L起始行-L结束行");
    startLine = Number(match[1]);
    endLine = Number(match[2]);
  } else {
    [startLine, endLine] = numericRange(range);
  }
  if (startLine < 1 || endLine < startLine || endLine > index.total_lines) throw new Error(`行号必须位于 1-${index.total_lines} 之间`);
  // Accept one extra line when an inclusive end line is calculated as a 1200-line span.
  if (endLine - startLine + 1 > MAX_DISPLAYED_READ_LINES + INCLUSIVE_RANGE_TOLERANCE) {
    throw new Error("单次最多读取 1200 行，请缩小范围后继续");
  }
  const sourcePath = resolveWorkspaceFile(workspace, index.source_file, "小说内部文本");
  const lines = (await fs.readFile(sourcePath, "utf8")).split(/\r?\n/u);
  return {
    source_file: index.source_file,
    source_index: `L${startLine}-L${endLine}`,
    start_line: startLine,
    end_line: endLine,
    content: lines.slice(startLine - 1, endLine).map((line, offset) => `${startLine + offset}: ${line}`).join("\n")
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const options = args.mode === "--chapter" ? { chapter: args.value } : args.mode === "--index" ? { sourceIndex: args.value } : { range: args.value };
    const result = await readNovelSource(args.workspace, options);
    process.stdout.write(`${JSON.stringify({ ok: true, message: "已读取指定范围的小说原文。", next_action: "只基于返回行号范围提炼事实或还原高光时刻。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "read-novel-source", message: error.message, next_action: "检查章节序号、行号范围或高光索引后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
