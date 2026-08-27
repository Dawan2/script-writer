#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJson, writeJson } from "./foreign-review-utils.mjs";

function parseArgs(argv) {
  if (argv.length !== 6 || argv[0] !== "--workspace" || argv[2] !== "--start-line" || argv[4] !== "--end-line") {
    throw new Error("请使用 --workspace <项目目录> --start-line <行号> --end-line <行号>");
  }
  return { workspace: path.resolve(argv[1]), start: Number(argv[3]), end: Number(argv[5]) };
}

function mergeRanges(ranges) {
  return ranges.sort((left, right) => left.start - right.start).reduce((merged, range) => {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
    return merged;
  }, []);
}

export async function recordReviewCoverage(workspace, start, end) {
  const filePath = path.join(workspace, "runtime", "review-coverage.json");
  const coverage = await readJson(filePath);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > coverage.total_lines) {
    throw new Error("审读范围必须位于正文行号范围内");
  }
  coverage.ranges = mergeRanges([...(coverage.ranges || []), { start, end }]);
  coverage.complete = coverage.ranges.length === 1 && coverage.ranges[0].start === 1 && coverage.ranges[0].end === coverage.total_lines;
  await writeJson(filePath, coverage);
  return coverage;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  recordReviewCoverage(args.workspace, args.start, args.end)
    .then((coverage) => process.stdout.write(`${JSON.stringify({ ok: true, message: coverage.complete ? "全文审读覆盖已记录。" : "审读范围已记录。", complete: coverage.complete, next_action: coverage.complete ? "完成评分卡和报告。" : "继续审读未覆盖的正文范围。" }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, tool: "记录审读覆盖", message: error.message, next_action: "使用审读索引中的正文行号重新记录范围。" }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
