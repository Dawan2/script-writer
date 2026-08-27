#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, parseIndexedChunks } from "./distillation-utils.mjs";

const OPTIONS = Object.freeze({ "--source": "source", "--start": "start", "--count": "count" });

export async function readSourceChunks(args) {
  const sourcePath = path.resolve(args.source);
  const chunks = parseIndexedChunks(await fs.readFile(sourcePath, "utf8"));
  if (!chunks.length) throw new Error("没有识别到 C0001 格式的原文证据索引");
  const start = Number(args.start);
  const count = Number(args.count);
  if (!Number.isInteger(start) || start < 1) throw new Error("--start 必须是大于等于 1 的整数");
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("--count 必须是 1-8 的整数");
  if (start > chunks.length) throw new Error(`--start 超出证据范围，当前共 ${chunks.length} 个证据块`);
  const selected = chunks.slice(start - 1, start - 1 + count);
  const nextStart = start + selected.length;
  const completed = nextStart > chunks.length;
  return {
    source: sourcePath,
    start,
    count: selected.length,
    total: chunks.length,
    completed,
    next_start: completed ? null : nextStart,
    chunks: selected
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  readSourceChunks(parseArgs(process.argv.slice(2), OPTIONS, ["source", "start", "count"]))
    .then((result) => process.stdout.write(`${JSON.stringify({
      ok: true,
      message: result.completed ? "原文已连续读取至结尾。" : "本段原文读取完成，请继续读取下一段。",
      ...result
    }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        tool: "分段读取蒸馏原文",
        message: error.message,
        next_action: "使用初始化工具返回的 indexed_source，并检查 start 和 count。"
      }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
