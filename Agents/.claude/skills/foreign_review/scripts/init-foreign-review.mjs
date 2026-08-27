#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDistributionBriefComplete } from "../../../tools/distribution-brief.mjs";
import { resetStageOutput } from "../../../tools/reset-stage-output.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { buildReviewSourceIndex } from "./index-review-source.mjs";
import {
  createReviewScoringState,
  createScorecardDimensions,
  parseJson5,
  renderReportScaffold,
  resolveProjectReviewContext,
  resolveReviewInput,
  REVIEW_SCORING_RELATIVE_PATH,
  REVIEW_METHOD_TEMPLATE,
  reviewScopeFromIndex,
  SCORING_TABLE,
  SCORING_TABLE_HASH,
  upgradeReviewScorecard,
  writeJson
} from "./foreign-review-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../references/review-scorecard.json5");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  const cwdWorkspace = path.resolve(argv[1]);
  const workspace = path.isAbsolute(argv[1]) || existsSync(cwdWorkspace) ? cwdWorkspace : path.resolve(agentRoot, argv[1]);
  return { workspace, updatedBy: argv[3] || "admin" };
}

async function writeIfBlank(filePath, content) {
  const existing = await fs.readFile(filePath, "utf8").catch(() => "");
  if (existing.trim()) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

async function writeRuntimeState(filePath, value, scriptHash) {
  const existing = await fs.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
  if (existing?.script_hash === scriptHash) return false;
  await writeJson(filePath, value);
  return true;
}

async function initializeReviewScoring(filePath, scriptHash, scorecard) {
  const existing = await fs.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
  if (existing?.["剧本哈希"] === scriptHash
    && existing?.["评分表版本"] === SCORING_TABLE.schema_version
    && existing?.["评分表哈希"] === SCORING_TABLE_HASH) {
    return false;
  }
  await writeJson(filePath, createReviewScoringState({ scriptHash, scorecard, previousState: existing }));
  return true;
}

function createScorecard(template, input, index) {
  const scorecard = structuredClone(template);
  const dimensions = createScorecardDimensions();
  const materials = [
    input.sourcePath ? `原始剧本：${path.basename(input.sourcePath)}` : `审读文本：${path.basename(input.scriptPath)}`,
    `审读文本：${path.basename(input.scriptPath)}`,
    ...input.upstreamFiles
  ].filter((item, position, values) => values.indexOf(item) === position);
  scorecard["审稿信息"] = {
    "审稿模式": input.mode,
    "剧本文件": input.scriptRelativePath,
    "剧本哈希": index.script_hash,
    "原始文件": input.sourceRelativePath || "未提供",
    "当前版本": input.scriptVersion,
    "审读集数": reviewScopeFromIndex(index),
    "目标市场": input.targetMarket,
    "目标语": input.targetLocale,
    "单集时长": input.episodeDuration,
    "内容分级": input.maturityTarget,
    "可用材料": materials,
    "判断边界": "仅对已提供且可读的正文作出判断；内容尺度以项目内容分级为上限，未提供目标市场、时长或当地内容规则时，只识别正文风险，不扩大结论。",
    "结构状态": index.structure_status,
    "审读范围": "待完成全文审读"
  };
  scorecard["剧本信息"]["剧本名称"] = input.title === "未提供"
    ? path.basename(input.scriptPath, path.extname(input.scriptPath))
    : input.title;
  scorecard["六维分析"] = dimensions;
  scorecard["评级依据"]["审稿方法"] = REVIEW_METHOD_TEMPLATE;
  scorecard["评级依据"]["六维结论"] = dimensions.map((item) => ({
    "分析维度": item["维度"],
    "评级": "",
    "结论": "",
    "一句话判断": ""
  }));
  return scorecard;
}

async function assertProjectReady(workspace) {
  const context = await resolveProjectReviewContext(workspace);
  if (!context) return null;
  assertDistributionBriefComplete(context.project);
  const targetRegion = context.project?.target_region?.trim();
  if (!targetRegion) throw new Error("1.1-user-input.json 缺少目标地区");
  if (!context.reviewOnly) {
    if (context.progress?.stages?.full_generate?.status !== "completed") throw new Error("full_generate 尚未完成");
    if (context.project.requires_translation !== false && context.progress?.stages?.dialogue_translate?.status !== "completed") throw new Error("dialogue_translate 尚未完成");
  }
  return context;
}

export async function initializeForeignReview(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [context, input] = await Promise.all([assertProjectReady(workspaceDir), resolveReviewInput(workspaceDir)]);
  if (process.env.ORCA_RESET_CURRENT_STAGE === "1") await resetStageOutput(workspaceDir, "foreign_review");
  const index = await buildReviewSourceIndex(workspaceDir);
  const template = parseJson5(await fs.readFile(templatePath, "utf8"));
  const runtime = path.join(workspaceDir, "runtime");
  const scorecardPath = path.join(workspaceDir, "review-scorecard.json");
  const reportPath = path.join(workspaceDir, "output", "审稿报告.md");
  const existingScorecardText = await fs.readFile(scorecardPath, "utf8").catch(() => "");
  let scorecard;
  if (!existingScorecardText.trim()) {
    scorecard = createScorecard(template, input, index);
    await writeJson(scorecardPath, scorecard);
  } else {
    const upgraded = upgradeReviewScorecard(JSON.parse(existingScorecardText));
    scorecard = upgraded.scorecard;
    if (upgraded.changed) await writeJson(scorecardPath, scorecard);
  }
  await writeIfBlank(reportPath, renderReportScaffold(scorecard));
  await initializeReviewScoring(path.join(workspaceDir, REVIEW_SCORING_RELATIVE_PATH), index.script_hash, scorecard);
  await writeRuntimeState(path.join(runtime, "review-coverage.json"), {
    schema_version: "1.0.0",
    script_hash: index.script_hash,
    total_lines: index.stats.total_lines,
    ranges: [],
    complete: false
  }, index.script_hash);
  await writeRuntimeState(path.join(runtime, "review-ledger.json"), {
    schema_version: "1.0.0",
    script_hash: index.script_hash,
    units: index.units.map((unit) => ({ ...unit, status: "未审读", "剧情功能": "", "冲突": "", "选择": "", "结果": "", "卡点": "", "人物动机": [], "规则变化": [], "矛盾点": [], "证据": [] }))
  }, index.script_hash);
  if (context) {
    const reviewState = context.progress?.stages?.foreign_review;
    if (reviewState && (Object.hasOwn(reviewState, "review_decision") || Object.hasOwn(reviewState, "revision_route_validation"))) {
      delete reviewState.review_decision;
      delete reviewState.revision_route_validation;
      await fs.writeFile(path.join(workspaceDir, "1.2-project-progress.json"), `${JSON.stringify(context.progress, null, 2)}\n`, "utf8");
    }
    if (context.reviewOnly && context.progress?.stages?.full_generate?.status !== "completed") {
      await updateProgress({
        workspace: workspaceDir,
        stage: "full_generate",
        status: "completed",
        updatedBy,
        nextSkill: "foreign_review",
        outputFiles: [input.scriptRelativePath]
      });
    }
    await updateProgress({
      workspace: workspaceDir,
      stage: "foreign_review",
      status: "in_progress",
      updatedBy,
      outputFiles: ["review-scorecard.json", "output/审稿报告.md"]
    });
  }

  return {
    workspace_dir: workspaceDir,
    scorecard_file: scorecardPath,
    report_file: reportPath,
    structure_status: index.structure_status,
    review_mode: input.mode,
    maturity_target: input.maturityTarget
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await initializeForeignReview(args.workspace, args.updatedBy);
    process.stdout.write(`${JSON.stringify({ ok: true, message: "海外审稿文件已初始化。", next_action: "全文审读剧本，记录审读覆盖并填写审读台账。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "foreign_review", tool: "init", message: error.message, next_action: "检查待审剧本、发行任务书或项目进度后重新初始化。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
