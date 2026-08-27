#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convertScriptToMarkdown } from "../../project_init/scripts/convert-script-to-md.mjs";
import { writeJson } from "./foreign-review-utils.mjs";

const FIELD_MAP = Object.freeze({
  "--workspace": "workspace",
  "--source": "source",
  "--script-title": "scriptTitle",
  "--script-version": "scriptVersion",
  "--review-mode": "reviewMode",
  "--target-market": "targetMarket",
  "--target-locale": "targetLocale",
  "--episode-duration": "episodeDuration",
  "--maturity-target": "maturityTarget",
  "--user-requirements": "userRequirements"
});

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const field = FIELD_MAP[option];
    if (!field || index + 1 >= argv.length) throw new Error("请使用 --workspace <项目目录> --source <剧本路径>，其余参数成对提供");
    args[field] = argv[index + 1];
  }
  if (!args.workspace || !args.source) throw new Error("缺少 --workspace 或 --source");
  if (args.reviewMode && !["standalone", "rewrite"].includes(args.reviewMode)) throw new Error("--review-mode 仅可为 standalone 或 rewrite");
  return args;
}

async function assertNoCompletedReview(workspace) {
  for (const relativePath of ["review-scorecard.json", path.join("output", "审稿报告.md")]) {
    const text = await fs.readFile(path.join(workspace, relativePath), "utf8").catch(() => "");
    if (text.trim()) throw new Error(`已有审稿产物：${relativePath}。请使用新的审稿目录，避免覆盖既有结论。`);
  }
}

export async function prepareReviewSource(args) {
  const workspace = path.resolve(args.workspace);
  const sourcePath = path.resolve(args.source);
  if (!(await fs.stat(sourcePath).catch(() => null))?.isFile()) throw new Error(`剧本文件不存在：${args.source}`);
  await assertNoCompletedReview(workspace);

  const scriptPath = path.join(workspace, "input", "待审剧本.md");
  const sourceTitle = path.basename(sourcePath, path.extname(sourcePath));
  const conversion = await convertScriptToMarkdown(sourcePath, scriptPath, { title: args.scriptTitle || sourceTitle });
  await writeJson(path.join(workspace, "review-input.json"), {
    review_mode: args.reviewMode || "standalone",
    script_path: path.relative(workspace, scriptPath),
    source_path: sourcePath,
    script_title: args.scriptTitle || sourceTitle,
    script_version: args.scriptVersion || "未提供",
    target_market: args.targetMarket || "未提供",
    target_locale: args.targetLocale || "未提供",
    episode_duration: args.episodeDuration || "未提供",
    maturity_target: args.maturityTarget,
    user_requirements: args.userRequirements || "未提供",
    source_conversion: conversion.converter
  });
  return { workspace, script_file: scriptPath, source_file: sourcePath, ...conversion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await prepareReviewSource(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, message: "待审剧本已导入并转换为可审读文本。", next_action: "调用初始化海外审稿，随后核对审读索引是否正确识别分集或场次。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "导入待审剧本", message: error.message, next_action: "检查源文件格式、审稿目录，或改用新的审稿目录后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
