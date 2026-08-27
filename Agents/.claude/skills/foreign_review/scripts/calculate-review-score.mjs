#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  admissionAllowsScoring,
  calculateReviewScoringState,
  hashText,
  readJson,
  resolveReviewInput,
  REVIEW_SCORING_RELATIVE_PATH,
  synchronizeScorecardGrades,
  writeJson
} from "./foreign-review-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") throw new Error("请使用 --workspace <项目目录>");
  const cwdWorkspace = path.resolve(argv[1]);
  const workspace = path.isAbsolute(argv[1]) || existsSync(cwdWorkspace) ? cwdWorkspace : path.resolve(agentRoot, argv[1]);
  return { workspace };
}

export async function calculateReviewScore(workspace) {
  const workspaceDir = path.resolve(workspace);
  const input = await resolveReviewInput(workspaceDir);
  const [scriptText, scorecard, scoringState] = await Promise.all([
    fs.readFile(input.scriptPath, "utf8"),
    readJson(path.join(workspaceDir, "review-scorecard.json")),
    readJson(path.join(workspaceDir, REVIEW_SCORING_RELATIVE_PATH))
  ]);
  if (!admissionAllowsScoring(scorecard)) {
    throw new Error("剧本尚未通过准入标准，不能进行六维评分");
  }
  const calculated = calculateReviewScoringState(scoringState, hashText(scriptText));
  const synchronizedScorecard = synchronizeScorecardGrades(scorecard, calculated);
  await Promise.all([
    writeJson(path.join(workspaceDir, REVIEW_SCORING_RELATIVE_PATH), calculated),
    writeJson(path.join(workspaceDir, "review-scorecard.json"), synchronizedScorecard)
  ]);
  return {
    workspace_dir: workspaceDir,
    message: "审稿评分已归并为对外评级。",
    next_action: "根据已同步的评级完成综合判定、问题分级和审稿报告。"
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await calculateReviewScore(parseArgs(process.argv.slice(2)).workspace);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      stage: "foreign_review",
      tool: "calculate-review-score",
      message: error.message,
      next_action: "先完成准入标准检查；准入通过后，再补齐内部检查项分数并重新计算。"
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
