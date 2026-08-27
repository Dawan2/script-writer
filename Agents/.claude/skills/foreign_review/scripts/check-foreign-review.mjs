#!/usr/bin/env node
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertDistributionBriefComplete } from "../../../tools/distribution-brief.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import {
  ADMISSION_CHECKS,
  admissionAllowsScoring,
  admissionConclusionForItems,
  baseGrade,
  DIMENSIONS,
  GRADES,
  isOverallGrade,
  REPAIR_SCOPES,
  REQUIRED_CHECKS,
  REVIEW_METHOD_TEMPLATE,
  REVIEW_SCORING_RELATIVE_PATH,
  SCORECARD_SCHEMA_VERSION,
  VERDICTS,
  hashText,
  isPlainObject,
  isText,
  normalizeLines,
  resolveProjectReviewContext,
  resolveReviewInput,
  reviewResultForGrade,
  validateReviewScoringState
} from "./foreign-review-utils.mjs";
import { hasProceduralLanguage, validateAdmissionGate } from "./check-review-admission.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const DETAIL_TABLE_HEADER = "| 检查项 | 评级 | 问题说明 | 原稿证据 |";
const RATING_TABLE_HEADER = "| 分析维度 | 评级 | 结论 | 一句话判断 |";
const ADMISSION_TABLE_HEADER = "| 检查项 | 结果 | 说明 |";
const SCORECARD_KEYS = Object.freeze(["schema_version", "审稿信息", "总体结论", "剧本信息", "卖点拆解", "准入标准", "评级依据", "六维分析", "P0问题", "P1问题", "风险与复核"]);
const DIMENSION_KEYS = Object.freeze(["维度", "评级", "判断", "检查项"]);
const CHECK_KEYS = Object.freeze(["检查项", "评级", "问题说明", "原稿证据"]);
const RATING_BASIS_KEYS = Object.freeze(["综合判定", "审读范围", "审稿方法", "六维结论"]);
const RATING_BASIS_ITEM_KEYS = Object.freeze(["分析维度", "评级", "结论", "一句话判断"]);
const SCRIPT_INFORMATION_KEYS = Object.freeze(["剧本名称", "题材", "剧本标签", "剧情梗概"]);
const SELLING_POINT_KEYS = Object.freeze(["卖点", "状态", "观众为什么看", "是否兑现", "证据"]);
const ISSUE_KEYS = Object.freeze(["问题", "原稿情况", "定位", "根因", "影响", "建议修改范围", "修改动作", "验收条件"]);
const RISK_REVIEW_KEYS = Object.freeze(["类别", "严重程度", "说明", "建议", "需要人工复核"]);
const REVIEW_INFO_KEYS = Object.freeze(["审稿模式", "剧本文件", "剧本哈希", "原始文件", "当前版本", "审读集数", "目标市场", "目标语", "单集时长", "内容分级", "可用材料", "判断边界", "结构状态", "审读范围"]);
const COMPRESSED_AUDIENCE_JUDGMENT = /(?:能|能够)(?:支撑|维持)(?![^。；]{0,10}(?:观众|用户))[^。；]{0,8}(?:追看|追更|观看)/u;
const REPAIR_STAGE = Object.freeze({
  "项目要求/选品": "project_init",
  "剧本大纲": "outline_rewrite",
  "人物与关系": "character_rewrite",
  "剧本前段": "trial_generate",
  "剧本全稿": "full_generate",
  "台词翻译": "dialogue_translate",
  "成片与制作": "full_generate",
  "海外发行复核": "foreign_review",
  "补充材料": "project_init"
});

function repairInstruction(issue, card) {
  const message = String(issue);
  const instruction = {
    code: "FOREIGN_REVIEW_VALIDATION",
    message,
    file: "review-scorecard.json",
    path: "",
    required: message,
    action: "在对应交付物中修正本项问题后，重新执行检查海外审稿。"
  };
  const set = (details) => Object.assign(instruction, details);
  const repairScopeText = REPAIR_SCOPES.join("、");
  const isAdmissionReportIssue = message.startsWith("准入标准必须先")
    || message.startsWith("准入标准必须在")
    || message.startsWith("准入不通过时，整体结论")
    || message.startsWith("准入不通过时，最终结论")
    || message.startsWith("最终结论未完整镜像准入");

  if (message.includes("审读索引")) {
    return set({
      code: "REBUILD_REVIEW_INDEX",
      file: "runtime/review-source-index.json",
      required: "索引必须对应当前待审剧本。",
      action: "执行建立审读索引，然后重新核对评分卡中的剧本哈希和审读范围。"
    });
  }
  if (message.includes("审读覆盖")) {
    return set({
      code: "COMPLETE_REVIEW_COVERAGE",
      file: "runtime/review-coverage.json",
      required: "覆盖范围必须从正文第 1 行连续覆盖至最后一行，且 complete 为 true。",
      action: "完成全文审读后，逐段调用记录审读覆盖，直到工具确认全文已覆盖。"
    });
  }
  if (message.includes("审读台账")) {
    return set({
      code: "REBUILD_REVIEW_LEDGER",
      file: "runtime/review-ledger.json",
      required: "台账必须与当前索引的每个审读单元一一对应，每项标记为已审读并包含正文证据。",
      action: "按当前审读索引补齐全部单元的剧情功能、冲突、选择、结果、卡点和证据，再调用写入审读台账。"
    });
  }
  if (message.includes("内部评分")) {
    return set({
      code: "RECALCULATE_REVIEW_SCORE",
      file: REVIEW_SCORING_RELATIVE_PATH,
      required: "内部评分必须与当前剧本和评分表一致，所有检查项分数为 0-100 的有效数值。",
      action: "补齐或修正内部评分后，执行计算审稿评分，让工具同步检查项、维度和总体评级。"
    });
  }
  if (message.startsWith("审稿文案")) {
    return set({
      code: "REWRITE_REVIEW_COPY",
      file: "review-scorecard.json",
      required: "用户可见结论必须先说明对象，再说明剧情事实或判断，最后说清它对观众、人物、故事或制作的影响。",
      action: "按“对象 → 事实或判断 → 影响”重写评分卡对应文案，避免概念并列和过程话语；再将同一文案镜像到报告。"
    });
  }
  if (message === "评级概述的审稿方法必须使用固定审稿流程") {
    return set({
      code: "FIX_REVIEW_METHOD",
      file: "review-scorecard.json",
      path: "评级依据 -> 审稿方法",
      required: "审稿方法必须使用固定的“全文与准入 → 故事与留存 → 成片与制作 → 发行与风险 → 评级与返修”流程。",
      action: "将评分卡中的审稿方法替换为初始化海外审稿提供的固定流程，并在报告的“审稿方法”小节原样呈现。"
    });
  }
  if ((message.includes("准入标准") || message.includes("集数达标")) && !isAdmissionReportIssue) {
    return set({
      code: "FIX_ADMISSION_GATE",
      file: "review-scorecard.json",
      path: "准入标准",
      required: `按固定顺序填写 ${ADMISSION_CHECKS.join("、")}；每项结果只能为“通过”“部分通过”或“不通过”，标题承诺兑现除外；说明只写一条加粗的编辑结论，原稿行号仅保存在原稿证据字段。`,
      action: "修正准入标准后执行检查准入标准，由工具归并准入结论；准入不通过时移除六维评级和 P0/P1。"
    });
  }
  if (message.includes("建议修改范围")) {
    const isIssueList = /^P[01]/u.test(message);
    return set({
      code: "INVALID_REPAIR_SCOPE",
      file: "review-scorecard.json",
      path: isIssueList ? "P0问题 或 P1问题 -> 建议修改范围" : "总体结论 -> 建议修改范围",
      required: `只能使用以下范围之一：${repairScopeText}。`,
      allowed_values: REPAIR_SCOPES,
      action: "根据最早需要调整的阶段选择一个允许值；不要使用“全剧”“全部改写”等未定义范围。"
    });
  }
  if (message.includes("风险与复核")) {
    const riskMatch = message.match(/风险与复核第\s*(\d+)\s*项/u);
    return set({
      code: "FIX_RISK_REVIEW",
      file: "review-scorecard.json",
      path: riskMatch ? `风险与复核 -> 第 ${riskMatch[1]} 项` : "风险与复核",
      required: `风险与复核必须是数组；每项必须是包含 ${RISK_REVIEW_KEYS.join("、")} 的对象，其中“需要人工复核”为 true 或 false。`,
      required_fields: RISK_REVIEW_KEYS,
      action: "将每条风险改为完整对象，补齐类别、严重程度、说明、建议，并明确是否需要人工复核。"
    });
  }
  if (message.includes("评分卡顶层字段") || message.includes("schema_version") || message.includes("评分卡缺少有效的审稿信息") || message.includes("评分卡缺少总体结论")) {
    return set({
      code: "FIX_SCORECARD_SCHEMA",
      file: "review-scorecard.json",
      path: message.includes("审稿信息") ? "审稿信息" : "顶层字段",
      required: `评分卡顶层字段必须为 ${SCORECARD_KEYS.join("、")}；schema_version 必须为 ${SCORECARD_SCHEMA_VERSION}。审稿信息必须填写 ${REVIEW_INFO_KEYS.join("、")}。`,
      action: "以初始化海外审稿生成的评分卡为基础补齐字段，不要自定义或删除字段。"
    });
  }
  if (message.includes("剧本哈希") || message.includes("剧本文件不是当前待审正文")) {
    return set({
      code: "SYNC_REVIEW_SOURCE",
      file: "review-scorecard.json",
      path: "审稿信息 -> 剧本文件、剧本哈希",
      required: "剧本文件和剧本哈希必须指向当前待审正文。",
      action: "确认当前待审剧本后，重新初始化审稿、建立索引、完成审读覆盖和台账，再重新评分。"
    });
  }
  if (message.includes("评级必须") || message.includes("评级未按") || message.includes("总体评级")) {
    return set({
      code: "SYNC_PUBLIC_GRADE",
      file: "review-scorecard.json",
      path: "六维分析、评级依据或总体结论",
      required: `单项和维度评级只能为 ${GRADES.join("、")}；总体评级只能为基础评级或带加号的评级，且必须与内部评分计算结果一致。`,
      allowed_values: GRADES,
      action: "不要手写对外评级。先修正 runtime/review-scoring.json 中的分数，再执行计算审稿评分。"
    });
  }
  if (message.includes("总体结论") && message.includes("不符合约定范围")) {
    return set({
      code: "INVALID_VERDICT",
      file: "review-scorecard.json",
      path: "总体结论 -> 结论",
      required: `结论只能为 ${VERDICTS.join("、")}。`,
      allowed_values: VERDICTS,
      action: "选择与当前审稿结论一致的允许值，并补齐一句话判断、建议修改范围和下一步。"
    });
  }
  if (message.includes("必须是对象") || message.includes("字段必须") || message.includes("字段不完整") || message.includes("字段完整")) {
    const isEvidence = message.includes("证据");
    const requiredFields = message.includes("评分维度")
      ? DIMENSION_KEYS
      : message.includes("检查项")
        ? CHECK_KEYS
        : message.includes("评级概述")
          ? RATING_BASIS_KEYS
          : message.includes("卖点")
            ? SELLING_POINT_KEYS
            : message.includes("P0") || message.includes("P1")
              ? ISSUE_KEYS
              : null;
    return set({
      code: "FIX_OBJECT_SCHEMA",
      file: "review-scorecard.json",
      required: isEvidence
        ? "每条正文证据必须是包含“起始行”“结束行”“说明”的对象。"
        : requiredFields
          ? `对象字段必须且只能为 ${requiredFields.join("、")}。`
          : "对象字段必须与初始化评分卡中的对应结构完全一致，不得缺少、增加或改名。",
      ...(requiredFields ? { required_fields: requiredFields } : {}),
      action: isEvidence
        ? "将该证据改为有效正文行号范围，并说明这段正文支持的判断。"
        : "以初始化评分卡的对应字段为准重建该对象，再填入已有审稿结论。"
    });
  }
  if (message.includes("正文证据") || message.includes("行号") || message.includes("正文定位")) {
    return set({
      code: "FIX_SOURCE_EVIDENCE",
      file: message.includes("台账") ? "runtime/review-ledger.json" : "review-scorecard.json",
      required: "每条证据都必须引用当前待审正文中存在且非空的起始行、结束行，并说明证据用途。",
      action: "回到当前待审正文，替换为真实的“第 X-Y 行”定位或证据对象；不要沿用旧版本行号。"
    });
  }
  const isReportIssue = message.startsWith("报告")
    || isAdmissionReportIssue
    || message.startsWith("当前准入结论")
    || message.startsWith("最终结论")
    || message.startsWith("修改建议")
    || message.startsWith("评分细则")
    || message.startsWith("核心卖点必须先")
    || message.startsWith("核心卖点应使用")
    || message.startsWith("剧本信息应使用")
    || message.startsWith("剧本信息必须按")
    || message.startsWith("剧本信息不应展示")
    || message.startsWith("评级概述标题")
    || message.startsWith("评级概述必须按")
    || message.startsWith("六维结论必须在")
    || message.startsWith("没有 P0")
    || message.startsWith("没有 P1")
    || message.startsWith("P0 问题标题")
    || message.startsWith("P1 问题")
    || message.startsWith("每个分析维度");
  if (isReportIssue) {
    const heading = message.match(/“(.+)”/u)?.[1];
    const expectedTitle = card?.["剧本信息"]?.["剧本名称"];
    const reportTitle = expectedTitle ? `# 《${expectedTitle}》审稿报告` : "初始化海外审稿生成的固定标题";
    const forbidden = message.includes("不应") || message.includes("不得");
    return set({
      code: "FIX_REVIEW_REPORT",
      file: "output/审稿报告.md",
      required: message.includes("报告标题")
        ? `报告标题必须为“${reportTitle}”。`
        : forbidden
          ? message
          : heading
        ? `报告必须包含并正确呈现“${heading}”。`
          : message,
      action: forbidden
        ? "只删除或替换报告中不允许出现的内容，保留评分卡已有的有效结论和证据。"
        : "只修改报告中的对应章节：补齐固定标题、按要求调整顺序或格式，并同步评分卡已有的结论和证据。"
    });
  }
  if (message.includes("不应保存分数") || message.includes("不得保留检查项、维度或总体分数")) {
    return set({
      code: "REMOVE_PUBLIC_SCORES",
      file: "review-scorecard.json",
      required: "评分卡和报告不得保存百分制分数或权重；这些数值只能存在于 runtime/review-scoring.json。",
      action: "从评分卡和报告中移除分数、权重及其说明，只保留工具计算并同步的字母评级。"
    });
  }
  if (message.includes("P0") || message.includes("P1")) {
    return set({
      code: "FIX_REPAIR_ISSUES",
      file: "review-scorecard.json",
      path: "P0问题 或 P1问题",
      required: `每项必须包含 ${ISSUE_KEYS.join("、")}；P0/P1 不得重复，准入不通过时必须均为空。`,
      action: "按问题根因合并重复项，补齐正文定位、影响、修改动作和验收条件；再同步报告中的修改建议。"
    });
  }
  if (message.includes("六维") || message.includes("评分维度") || message.includes("检查项")) {
    return set({
      code: "FIX_DIMENSION_ANALYSIS",
      file: "review-scorecard.json",
      path: "六维分析或评级依据",
      required: `六维分析必须按 ${DIMENSIONS.join("、")} 的固定顺序填写，并保留每个维度规定的检查项。`,
      action: "依据对应维度资料补齐结论、检查项、问题说明和正文证据；完成内部评分后再同步评级。"
    });
  }
  if (message.endsWith("不能为空") || message.includes("至少需要") || message.includes("需要")) {
    return set({
      code: "COMPLETE_REQUIRED_CONTENT",
      file: "review-scorecard.json",
      required: message,
      action: "在问题所指字段补充当前剧本可核验的完整内容，避免使用占位文字，然后重新检查。"
    });
  }
  return instruction;
}

function repairInstructions(issues, card) {
  return issues.map((issue) => repairInstruction(issue, card));
}

function runtimeFailureInstruction(error) {
  const message = error?.message || String(error);
  const missingPath = error?.path || message.match(/open '([^']+)'/u)?.[1];
  const invalidJson = error?.code === "INVALID_JSON";
  return {
    code: error?.code === "ENOENT" ? "MISSING_REVIEW_FILE" : invalidJson ? "INVALID_REVIEW_JSON" : "FOREIGN_REVIEW_EXECUTION_ERROR",
    message,
    file: missingPath || "项目目录",
    path: "",
    required: error?.code === "ENOENT"
      ? "检查所需的评分卡、内部评分状态、审读记录和报告文件必须存在。"
      : invalidJson
        ? "JSON 文件必须是可解析的 JSON，且保留初始化工具生成的字段结构。"
        : "检查工具必须能读取当前项目的全部审稿交付物。",
    action: error?.code === "ENOENT"
      ? "确认 --workspace 指向实际项目目录；缺少文件时先执行初始化海外审稿，并完成对应步骤后再检查。"
      : invalidJson
        ? "修正该 JSON 文件的语法和字段结构；不要保留注释、尾随逗号或截断内容。"
      : "按 message 指出的文件或数据修复读取错误后重新执行检查海外审稿。"
  };
}

function failedArtifactResult(errors) {
  const repair = errors.map((error) => runtimeFailureInstruction(error));
  return {
    ok: false,
    issue_count: repair.length,
    issues: repair.map((item) => item.message),
    repair_instructions: repair,
    next_action: "按 repair_instructions 中每一项的 action 补齐或修复全部审稿交付物后重新检查。"
  };
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  const cwdWorkspace = path.resolve(argv[1]);
  const workspace = path.isAbsolute(argv[1]) || existsSync(cwdWorkspace) ? cwdWorkspace : path.resolve(agentRoot, argv[1]);
  return { workspace, updatedBy: argv[3] || "admin" };
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function contentHash(content) {
  return hashText(content);
}

function reviewDecisionArtifactHashes({ scriptRelativePath, fullScript, scorecardText, scoringText, report }) {
  const artifacts = {
    [scriptRelativePath]: contentHash(fullScript),
    "review-scorecard.json": contentHash(scorecardText),
    [REVIEW_SCORING_RELATIVE_PATH]: contentHash(scoringText),
    "output/审稿报告.md": contentHash(report)
  };
  return artifacts;
}

function existingReviewDecision(progress, artifactHashes) {
  const stages = progress?.stages;
  const review = stages?.foreign_review;
  const decision = review?.review_decision;
  if (!isPlainObject(decision) || !["passed", "revision_requested"].includes(decision.outcome)) return null;
  const revisionStage = decision.revision_stage;
  if (decision.outcome === "revision_requested" && !Object.values(REPAIR_STAGE).includes(revisionStage)) return null;
  const artifacts = Object.keys(artifactHashes);
  if (!isPlainObject(decision.artifact_hashes)
    || Object.keys(decision.artifact_hashes).length !== artifacts.length
    || !artifacts.every((file) => decision.artifact_hashes[file] === artifactHashes[file])) return null;
  const awaitingApproval = review.status === "awaiting_approval";
  if (decision.outcome === "passed" && !awaitingApproval) return null;
  if (decision.outcome === "revision_requested" && !awaitingApproval && review.status !== "completed") return null;
  return {
    ok: true,
    outcome: awaitingApproval ? "awaiting_approval" : "revision_requested",
    verdict: decision.verdict,
    revision_stage: revisionStage,
    review_decision: decision.outcome,
    already_recorded: true,
  };
}

async function recordReviewDecision({ workspace, status, updatedBy, outputFiles, decision }) {
  const result = await updateProgress({
    workspace,
    stage: "foreign_review",
    status,
    allowApprovalState: status === "awaiting_approval",
    updatedBy,
    outputFiles,
  });
  const progressPath = path.join(workspace, "1.2-project-progress.json");
  const progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
  const review = progress.stages?.foreign_review || {};
  progress.stages.foreign_review = {
    ...review,
    quality_check: {
      passed: true,
      checks: ["审稿报告已通过格式与内容检查"],
      warnings: [],
    },
    review_decision: decision,
    next_action: decision.outcome === "revision_requested"
      ? "海外审稿建议调整相关内容。请查看审稿报告，并在对应文件中手动重新生成；调整完成后重新生成审稿报告。"
      : "审稿报告已通过检查，等待确认。",
  };
  delete progress.stages.foreign_review.last_error;
  delete progress.stages.foreign_review.revision_route_validation;
  delete progress.stages.foreign_review.invalidated_by;
  await fs.writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  return result;
}

function requireText(value, label, issues) {
  if (!isText(value)) issues.push(`${label}不能为空`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function lineRanges(value) {
  return [...String(value || "").matchAll(/第\s*(\d+)\s*[-~至—]\s*(\d+)\s*行/gu)].map((match) => ({ start: Number(match[1]), end: Number(match[2]) }));
}

function checkLineLocator(value, label, lines, issues) {
  const ranges = lineRanges(value);
  if (!ranges.length) {
    issues.push(`${label}必须包含“第 X-Y 行”的正文定位`);
    return;
  }
  ranges.forEach((range) => {
    if (range.start < 1 || range.end < range.start || range.end > lines.length || !lines.slice(range.start - 1, range.end).join("\n").trim()) {
      issues.push(`${label}引用了无效正文行号`);
    }
  });
}

function checkEvidence(evidence, label, lines, issues) {
  if (!Array.isArray(evidence) || !evidence.length) {
    issues.push(`${label}至少需要一条正文证据`);
    return;
  }
  evidence.forEach((item, index) => {
    const itemLabel = `${label}第 ${index + 1} 条证据`;
    if (!isPlainObject(item)) {
      issues.push(`${itemLabel}必须是对象`);
      return;
    }
    const start = item["起始行"];
    const end = item["结束行"];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length || !lines.slice(start - 1, end).join("\n").trim()) {
      issues.push(`${itemLabel}的行号不在有效剧本文本范围内`);
    }
    requireText(item["说明"], `${itemLabel}的说明`, issues);
  });
}

function checkInspectionItems(items, dimension, scoringDimension, lines, issues) {
  const dimensionName = dimension["维度"] || "评分维度";
  const required = REQUIRED_CHECKS[dimensionName] || [];
  if (!Array.isArray(items) || items.length !== required.length) {
    issues.push(`${dimensionName}必须包含 ${required.length} 个串行检查项`);
    return;
  }
  const names = [];
  items.forEach((item, index) => {
    const label = `${dimensionName}第 ${index + 1} 个检查项`;
    if (!hasExactKeys(item, CHECK_KEYS)) {
      issues.push(`${label}字段必须为“检查项、评级、问题说明、原稿证据”`);
      return;
    }
    ["检查项", "问题说明"].forEach((field) => requireText(item[field], `${label}的${field}`, issues));
    if (isText(item["检查项"])) names.push(item["检查项"]);
    if (!GRADES.includes(item["评级"])) issues.push(`${label}的评级必须为 D、C、B、A、S 或 SS`);
    const scoringCheck = Array.isArray(scoringDimension?.["检查项"])
      ? scoringDimension["检查项"][index]
      : null;
    if (GRADES.includes(item["评级"]) && scoringCheck?.["评级"] && item["评级"] !== scoringCheck["评级"]) {
      issues.push(`${label}的评级必须由内部评分计算结果同步`);
    }
    checkEvidence(item["原稿证据"], label, lines, issues);
  });
  if (JSON.stringify(names) !== JSON.stringify(required)) {
    issues.push(`${dimensionName}必须按固定顺序使用：${required.join(" → ")}`);
  }
  if (GRADES.includes(dimension["评级"]) && scoringDimension?.["评级"] && dimension["评级"] !== scoringDimension["评级"]) {
    issues.push(`${dimensionName}的评级必须由内部评分计算结果同步`);
  }
}

function checkLedger(ledger, sourceHash, lines, issues) {
  if (!isPlainObject(ledger) || ledger.script_hash !== sourceHash) {
    issues.push("审读台账与当前剧本文本不一致，需要重新建立并审读");
    return;
  }
  if (!Array.isArray(ledger.units) || !ledger.units.length) {
    issues.push("审读台账缺少审读单元");
    return;
  }
  ledger.units.forEach((unit, index) => {
    const label = `审读台账第 ${index + 1} 单元`;
    if (!isPlainObject(unit) || unit.status !== "已审读") {
      issues.push(`${label}必须标记为已审读`);
      return;
    }
    ["剧情功能", "冲突", "结果", "卡点"].forEach((field) => requireText(unit[field], `${label}的${field}`, issues));
    checkEvidence(unit["证据"], label, lines, issues);
  });
}

function checkIssueList(items, priority, lines, issues) {
  if (!Array.isArray(items)) {
    issues.push(`${priority}问题必须是数组`);
    return;
  }
  if (items.length > 10) issues.push(`${priority}问题不应超过 10 条，应先归并同一根因`);
  const titles = [];
  items.forEach((item, index) => {
    const label = `${priority}第 ${index + 1} 项`;
    if (!hasExactKeys(item, ISSUE_KEYS)) {
      issues.push(`${label}字段不完整`);
      return;
    }
    ["问题", "原稿情况", "定位", "根因", "影响", "修改动作", "验收条件"].forEach((field) => requireText(item[field], `${label}的${field}`, issues));
    const title = String(item["问题"] || "").trim();
    if (title) titles.push(title);
    if (title.length > 32 || /[\r\n。；：]/u.test(title)) issues.push(`${label}的问题必须是简短的核心问题标题`);
    checkLineLocator(item["定位"], `${label}的定位`, lines, issues);
    if (!REPAIR_SCOPES.includes(item["建议修改范围"])) issues.push(`${label}的建议修改范围不符合约定`);
  });
  if (new Set(titles).size !== titles.length) issues.push(`${priority}问题标题不能重复`);
}

function checkReviewInfo(info, sourceHash, issues) {
  if (!isPlainObject(info)) {
    issues.push("评分卡缺少有效的审稿信息");
    return;
  }
  ["审稿模式", "剧本文件", "剧本哈希", "原始文件", "当前版本", "审读集数", "目标市场", "目标语", "单集时长", "内容分级", "判断边界", "结构状态", "审读范围"].forEach((field) => requireText(info[field], `审稿信息的${field}`, issues));
  if (info["剧本哈希"] !== sourceHash) issues.push("审稿信息的剧本哈希与当前文本不一致，需要重新审读");
  if (!Array.isArray(info["可用材料"]) || !info["可用材料"].length || info["可用材料"].some((item) => !isText(item))) issues.push("审稿信息的可用材料至少需要一项");
  if (!/全(?:剧|文)/u.test(String(info["审读范围"] || ""))) issues.push("完成正式审稿后，审读范围必须明确为全剧或全文");
}

function checkScriptInformation(card, lines, issues) {
  const information = card["剧本信息"];
  if (!hasExactKeys(information, SCRIPT_INFORMATION_KEYS)) {
    issues.push("剧本信息字段必须与评分卡模板一致");
  } else {
    ["剧本名称", "剧情梗概"].forEach((field) => requireText(information[field], `剧本信息的${field}`, issues));
    if (!Array.isArray(information["题材"]) || !information["题材"].length || information["题材"].some((item) => !isText(item))) issues.push("剧本信息的题材至少需要一项");
    if (!Array.isArray(information["剧本标签"]) || information["剧本标签"].length < 3 || information["剧本标签"].length > 6 || information["剧本标签"].some((item) => !isText(item))) {
      issues.push("剧本信息的剧本标签需要 3 至 6 个有效标签");
    }
  }
  const sellingPoints = card["卖点拆解"];
  if (!Array.isArray(sellingPoints) || !sellingPoints.length || sellingPoints.length > 3) {
    issues.push("卖点拆解需要 1 至 3 项已核验卖点");
    return;
  }
  sellingPoints.forEach((item, index) => {
    const label = `卖点拆解第 ${index + 1} 项`;
    if (!hasExactKeys(item, SELLING_POINT_KEYS)) {
      issues.push(`${label}字段必须与评分卡模板一致`);
      return;
    }
    ["卖点", "观众为什么看", "是否兑现"].forEach((field) => requireText(item[field], `${label}的${field}`, issues));
    if (!["可保留", "兑现不足", "不建议继续押注"].includes(item["状态"])) issues.push(`${label}的状态不符合约定`);
    checkEvidence(item["证据"], label, lines, issues);
  });
}

function checkRatingBasis(basis, dimensions, issues) {
  if (!hasExactKeys(basis, RATING_BASIS_KEYS)) {
    issues.push("评级概述字段必须与评分卡模板一致");
    return;
  }
  ["综合判定", "审读范围", "审稿方法"].forEach((field) => requireText(basis[field], `评级概述的${field}`, issues));
  if (basis["审稿方法"] !== REVIEW_METHOD_TEMPLATE) issues.push("评级概述的审稿方法必须使用固定审稿流程");
  const comprehensive = String(basis["综合判定"] || "").trim();
  if (comprehensive.length < 80) issues.push("综合判定需要提炼主要成立点、损耗位置和返修重点，不应只复述等级");
  const gradeMentions = comprehensive.match(/(?<![A-Z])(?:SS|S|A|B|C|D)(?![A-Z])/gu) || [];
  if (gradeMentions.length > 1) issues.push("综合判定不应逐项复述维度等级");
  const conclusions = basis["六维结论"];
  if (!Array.isArray(conclusions) || conclusions.length !== DIMENSIONS.length) {
    issues.push("评级概述必须包含六维结论");
    return;
  }
  conclusions.forEach((item, index) => {
    const dimension = dimensions[index];
    const label = `评级概述第 ${index + 1} 项`;
    if (!hasExactKeys(item, RATING_BASIS_ITEM_KEYS) || item["分析维度"] !== DIMENSIONS[index]) {
      issues.push(`${label}必须对应“${DIMENSIONS[index]}”，且字段完整`);
      return;
    }
    ["评级", "结论", "一句话判断"].forEach((field) => requireText(item[field], `${label}的${field}`, issues));
    if (!GRADES.includes(item["评级"])) issues.push(`${label}的评级必须为 D、C、B、A、S 或 SS`);
    if (item["结论"] !== reviewResultForGrade(item["评级"])) issues.push(`${label}的结论必须与评级一致`);
    if (dimension?.["评级"] && item["评级"] !== dimension["评级"]) issues.push(`${label}的评级必须与对应维度一致`);
  });
}

function checkContentQuality(card, issues) {
  const dimensions = card["六维分析"] || [];
  const judgments = dimensions.map((item) => String(item?.["判断"] || "").trim()).filter(Boolean);
  if (new Set(judgments).size < Math.min(4, dimensions.length)) issues.push("六维判断重复度过高，未形成独立分析");
  dimensions.forEach((dimension) => {
    if (!isPlainObject(dimension)) return;
    (dimension["检查项"] || []).forEach((item, index) => {
      if (String(item?.["问题说明"] || "").trim().length < 16) issues.push(`${dimension["维度"] || "评分维度"}第 ${index + 1} 个检查项的问题说明过短`);
    });
  });
  const titles = [...(card["P0问题"] || []), ...(card["P1问题"] || [])].map((item) => item?.["问题"]).filter(isText);
  if (new Set(titles).size !== titles.length) issues.push("P0 与 P1 之间不能重复同一核心问题");
}

function checkEditorialCopy(card, issues) {
  const fields = [];
  const add = (label, value) => {
    if (isText(value)) fields.push([label, value.trim()]);
  };

  const conclusion = card["总体结论"] || {};
  add("总体结论的一句话判断", conclusion["一句话判断"]);
  add("总体结论的下一步", conclusion["下一步"]);

  (card["卖点拆解"] || []).forEach((item, index) => {
    add(`卖点拆解第 ${index + 1} 项的观众为什么看`, item?.["观众为什么看"]);
    add(`卖点拆解第 ${index + 1} 项的是否兑现`, item?.["是否兑现"]);
  });

  const admission = card["准入标准"] || {};
  add("准入标准的一句话判断", admission["一句话判断"]);
  (admission["检查项"] || []).forEach((item, index) => add(`准入标准第 ${index + 1} 项的说明`, item?.["说明"]));

  const basis = card["评级依据"] || {};
  add("评级概述的综合判定", basis["综合判定"]);
  (basis["六维结论"] || []).forEach((item, index) => add(`评级概述第 ${index + 1} 项的一句话判断`, item?.["一句话判断"]));

  (card["六维分析"] || []).forEach((dimension) => {
    const name = dimension?.["维度"] || "评分维度";
    add(`${name}的维度判断`, dimension?.["判断"]);
    (dimension?.["检查项"] || []).forEach((item, index) => add(`${name}第 ${index + 1} 个检查项的问题说明`, item?.["问题说明"]));
  });

  [...(card["P0问题"] || []), ...(card["P1问题"] || [])].forEach((item, index) => {
    const label = `修改建议第 ${index + 1} 项`;
    ["原稿情况", "根因", "影响", "修改动作"].forEach((field) => add(`${label}的${field}`, item?.[field]));
  });
  (card["风险与复核"] || []).forEach((item, index) => {
    add(`风险与复核第 ${index + 1} 项的说明`, item?.["说明"]);
    add(`风险与复核第 ${index + 1} 项的建议`, item?.["建议"]);
  });

  fields.forEach(([label, value]) => {
    if (hasProceduralLanguage(value)) {
      issues.push(`审稿文案“${label}”不应出现分析过程话语，应直接说明编辑判断`);
    }
    if (COMPRESSED_AUDIENCE_JUDGMENT.test(value)) {
      issues.push(`审稿文案“${label}”不应使用无对象的“能支撑追看”式压缩表达，应写清哪条剧情线如何推动观众继续观看`);
    }
  });
}

function checkNoPublicScores(card, issues) {
  const publicScoreFields = /"(?:总分|得分|分数|权重)"\s*:/u;
  if (publicScoreFields.test(JSON.stringify(card))) {
    issues.push("review-scorecard.json 不应保存分数或权重，数值只能保留在 runtime/review-scoring.json");
  }
}

function reportHasRange(report, start, end) {
  return new RegExp(`第\\s*${start}\\s*[-~至—]\\s*${end}\\s*行`, "u").test(report);
}

function reportSection(report, heading) {
  const start = report.indexOf(heading);
  if (start < 0) return "";
  const contentStart = start + heading.length;
  const level = heading.match(/^#+/u)?.[0].length || 3;
  const nextHeading = report.slice(contentStart).search(level === 2 ? /\n##\s/u : /\n#{2,3}\s/u);
  const end = nextHeading < 0 ? report.length : contentStart + nextHeading;
  return report.slice(contentStart, end);
}

function tableRows(section, header) {
  const lines = section.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex < 0 || !/^\|\s*---/u.test(lines[headerIndex + 1] || "")) return [];
  const rows = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#") || !line.startsWith("|")) break;
    rows.push(line);
  }
  return rows;
}

function checkReport(report, card, issues) {
  const conclusion = card["总体结论"] || {};
  const information = card["剧本信息"] || {};
  const reviewInfo = card["审稿信息"] || {};
  const admission = card["准入标准"] || {};
  const admitted = admissionAllowsScoring(card);
  const basis = card["评级依据"] || {};
  const dimensions = card["六维分析"] || [];
  const commonHeadings = [
    "## 一、审核结论",
    "### 1. 整体结论",
    "### 2. 剧本信息",
    "### 3. 核心卖点",
    "## 二、准入标准"
  ];
  const requiredHeadings = admitted
    ? [
      ...commonHeadings,
      "## 三、评级概述",
      "### 1. 审读范围",
      "### 2. 审稿方法",
      "### 3. 维度结论",
      "## 四、评分细则",
      "## 五、修改建议",
      "### 1. P0 问题",
      "### 2. P1 问题",
      "## 六、最终结论"
    ]
    : [...commonHeadings, "## 三、最终结论"];
  requiredHeadings.forEach((heading) => {
    if (!report.includes(heading)) issues.push(`报告缺少“${heading}”`);
  });
  const expectedTitle = `# 《${information["剧本名称"] || ""}》审稿报告`;
  if (!report.startsWith(`${expectedTitle}\n`)) issues.push(`报告标题必须为“${expectedTitle}”`);
  ["## 二、评级依据", "### 1. 综合判定", "## 二、决策摘要", "## 三、剧本信息", "## 四、分析细节", "## 六、剧本围读", "## 七、最终结论", "## 编辑结论与下一步"].forEach((heading) => {
    if (report.includes(heading)) issues.push(`报告不应保留旧章节“${heading}”`);
  });
  const forbiddenByAdmission = admitted
    ? ["## 三、最终结论"]
    : ["## 三、评级概述", "## 四、评分细则", "## 五、修改建议", "### 1. P0 问题", "### 2. P1 问题", "## 六、最终结论"];
  forbiddenByAdmission.forEach((heading) => {
    if (report.includes(heading)) issues.push(`当前准入结论下不应出现“${heading}”`);
  });
  if (/<\/?(?:div|h[1-6]|p|table|span|br)\b/iu.test(report)) issues.push("报告应使用标准 Markdown，不应包含 HTML 排版标签");
  const conversationalHeading = [...report.matchAll(/^#{2,4}\s+(.+)$/gmu)]
    .map((match) => match[1])
    .find((heading) => /为什么|能不能|是否|怎么|先看|再看|最后看/u.test(heading));
  if (conversationalHeading) issues.push(`报告标题“${conversationalHeading}”应改为固定的文档标题`);
  const publicScoreSignals = [
    /(?:总分|得分|分数|权重)/u,
    /\|\s*(?:分数|评分|得分|权重)\s*\|/u,
    /(?:^|[（(，,：:\s])\d+(?:\.\d+)?\s*\/\s*100(?=$|[）)，,。；;])/mu
  ];
  if (publicScoreSignals.some((pattern) => pattern.test(report))) {
    issues.push("报告不应展示百分制、分数或权重，只展示字母评级");
  }
  if (/这不是.{0,36}而是/u.test(report)) issues.push("报告不应使用“这不是……而是……”式自我说明");
  if (/本节重点|以下按|评级怎么(?:得出|落下)|下面将/u.test(report)) issues.push("报告不应加入自问自答或报告自我说明");
  if (hasProceduralLanguage(report)) issues.push("报告不应出现分析过程话语，应直接陈述编辑结论和原稿事实");
  if (/TODO|待填写|提示词|运行路径|内部台账/u.test(report)) issues.push("报告包含内部内容或待填写占位符");
  if (/\\\*\\\*/u.test(report)) issues.push("报告不应转义 Markdown 加粗标记");
  if (/。；|；。/u.test(report)) issues.push("报告中的证据连接符不得出现“。；”或“；。”");
  if (/(?<![\p{L}\p{N}])\*\*[^*\r\n]+\*\*(?=[\p{L}\p{N}])/u.test(report)) {
    issues.push("报告中的加粗标签与后续文字之间必须留一个空格");
  }

  const decisionSection = reportSection(report, "### 1. 整体结论");
  [["审核结论", conclusion["结论"]], ["总体评级", conclusion["评级"]], ["一句话评估", conclusion["一句话判断"]]].forEach(([label, value]) => {
    if (isText(value) && (!decisionSection.includes(`${label}：`) || !decisionSection.includes(value))) issues.push(`报告未镜像${label}`);
  });
  if (/建议修改范围|^- 下一步：/mu.test(decisionSection)) issues.push("整体结论不应展示内部返修范围或下一步字段");

  const informationSection = reportSection(report, "### 2. 剧本信息");
  if (/^\s*\|/mu.test(informationSection)) issues.push("剧本信息应使用列表，不使用表格");
  const informationValues = [
    ["剧集名称", information["剧本名称"]],
    ["目标市场", reviewInfo["目标市场"]],
    ["目标语与时长", [reviewInfo["目标语"], reviewInfo["单集时长"]].filter(isText).join("，")],
    ["剧情梗概", information["剧情梗概"]],
    ["题材", (information["题材"] || []).join("、")],
    ["剧本标签", (information["剧本标签"] || []).join("、")],
  ];
  const informationPositions = [];
  informationValues.forEach(([label, value]) => {
    const prefix = `- ${label}：`;
    if (!informationSection.includes(prefix) || (isText(value) && !informationSection.includes(value))) issues.push(`报告未镜像剧本信息“${label}”`);
    informationPositions.push(informationSection.indexOf(prefix));
  });
  if (informationPositions.some((position) => position < 0) || informationPositions.some((position, index) => index && position < informationPositions[index - 1])) {
    issues.push("剧本信息必须按“剧集名称 → 目标市场 → 目标语与时长 → 剧情梗概 → 题材 → 剧本标签”呈现");
  }
  if (/-\s*(?:当前版本|频类)：|\*\*一句话介绍：\*\*/u.test(informationSection)) {
    issues.push("剧本信息不应展示当前版本、频类或一句话介绍");
  }

  const sellingPointSection = reportSection(report, "### 3. 核心卖点");
  if (/^\s*\|/mu.test(sellingPointSection)) issues.push("核心卖点应使用分项说明，不使用表格");
  const sellingPoints = card["卖点拆解"] || [];
  const firstSellingPointIndex = sellingPoints.length ? sellingPointSection.search(/^1\.\s+/mu) : -1;
  const sellingPointConclusion = firstSellingPointIndex < 0 ? "" : sellingPointSection.slice(0, firstSellingPointIndex).trim();
  if (sellingPointConclusion.length < 12) issues.push("核心卖点必须先写结论，再展开分项说明");
  sellingPoints.forEach((item, index) => {
    const values = [item?.["卖点"], item?.["状态"], item?.["观众为什么看"], item?.["是否兑现"]];
    if (values.some((value) => !isText(value)) || !values.every((value) => sellingPointSection.includes(value))) issues.push("报告未完整镜像核心卖点");
    const title = `${index + 1}. **${item?.["卖点"] || ""}**（${item?.["状态"] || ""}）`;
    if (!sellingPointSection.includes(title)) issues.push(`报告未按分项格式展示第 ${index + 1} 项核心卖点`);
    if (!sellingPointSection.includes("- 观众吸引力：") || !sellingPointSection.includes("- 正文兑现：")) issues.push("核心卖点必须说明观众吸引力和正文兑现");
  });

  const admissionSection = report.match(/## 二、准入标准\s*([\s\S]*?)(?=\s*## [三四五六]、|$)/u)?.[1] || "";
  const admissionHeaderIndex = admissionSection.indexOf(ADMISSION_TABLE_HEADER);
  const admissionSummary = admissionHeaderIndex < 0 ? "" : admissionSection.slice(0, admissionHeaderIndex).trim();
  if (isText(admission["一句话判断"]) && admissionSummary !== admission["一句话判断"].trim()) {
    issues.push("准入标准必须先用一句话说明当前准入情况，再展示检查表");
  }
  const admissionItems = admission["检查项"] || [];
  const admissionRows = tableRows(admissionSection, ADMISSION_TABLE_HEADER);
  if (admissionRows.length !== ADMISSION_CHECKS.length) issues.push("准入标准必须在一张表中展示十个固定检查项");
  admissionItems.forEach((item) => {
    const pattern = new RegExp(`\\|\\s*${escapeRegExp(item?.["检查项"])}\\s*\\|\\s*${escapeRegExp(item?.["结果"])}\\s*\\|`, "u");
    if (!pattern.test(admissionSection)) issues.push(`报告未镜像准入检查项“${item?.["检查项"] || "未知检查项"}”及其结果`);
    if (isText(item?.["说明"]) && !admissionSection.includes(item["说明"])) issues.push(`报告未镜像准入检查项“${item?.["检查项"]}”的说明`);
    const row = admissionRows.find((line) => pattern.test(line));
    if (row && /(?:依据|证据)：|第\s*\d+\s*[-~至—]\s*\d+\s*行/u.test(row)) {
      issues.push(`准入检查项“${item?.["检查项"]}”的说明只保留编辑结论，不展示原稿证据清单`);
    }
  });

  if (!admitted) {
    if (conclusion["评级"] !== "未评级") issues.push("准入不通过时，整体结论中的总体评级必须显示为“未评级”");
    const finalSection = report.match(/## 三、最终结论\s*([\s\S]*)$/u)?.[1]?.trim() || "";
    if (!finalSection.includes("不符合准入门槛")) issues.push("准入不通过时，最终结论必须明确说明剧本不符合准入门槛");
    if (isText(conclusion["下一步"]) && !finalSection.includes(conclusion["下一步"])) issues.push("最终结论需要镜像下一步处理顺序");
    const suggestions = Array.isArray(admission["修改建议"]) ? admission["修改建议"] : [];
    suggestions.forEach((suggestion) => {
      if (!finalSection.includes(suggestion)) issues.push("最终结论未完整镜像准入修改建议");
    });
    return;
  }

  const ratingBasisSection = report.match(/## 三、评级概述\s*([\s\S]*?)\s*## 四、评分细则/u)?.[1] || "";
  const scopeHeading = "### 1. 审读范围";
  const methodHeading = "### 2. 审稿方法";
  const dimensionHeading = "### 3. 维度结论";
  const scopeIndex = ratingBasisSection.indexOf(scopeHeading);
  const comprehensiveSection = scopeIndex < 0 ? "" : ratingBasisSection.slice(0, scopeIndex).trim();
  if (isText(basis["综合判定"]) && comprehensiveSection !== basis["综合判定"].trim()) issues.push("评级概述标题下应直接展示综合判定，不设小标题或追加其他内容");
  if (!(ratingBasisSection.indexOf(scopeHeading) < ratingBasisSection.indexOf(methodHeading)
    && ratingBasisSection.indexOf(methodHeading) < ratingBasisSection.indexOf(dimensionHeading))) {
    issues.push("评级概述必须按“审读范围 → 审稿方法 → 维度结论”展开");
  }
  const dimensionConclusionSection = reportSection(report, dimensionHeading);
  const basisRows = tableRows(dimensionConclusionSection, RATING_TABLE_HEADER);
  const basisItems = basis["六维结论"] || [];
  if (basisRows.length !== basisItems.length) issues.push("六维结论必须在一张表中镜像全部维度");
  basisItems.forEach((item) => {
    const pattern = new RegExp(`\\|\\s*${escapeRegExp(item?.["分析维度"])}\\s*\\|\\s*${escapeRegExp(item?.["评级"])}\\s*\\|\\s*${escapeRegExp(item?.["结论"])}\\s*\\|\\s*${escapeRegExp(item?.["一句话判断"])}\\s*\\|`, "u");
    if (!pattern.test(dimensionConclusionSection)) issues.push(`报告未镜像${item?.["分析维度"] || "评分维度"}的六维结论`);
  });
  const scopeSection = reportSection(report, scopeHeading);
  if (isText(basis["审读范围"]) && !scopeSection.includes(basis["审读范围"])) issues.push("报告未镜像审读范围");
  const methodSection = reportSection(report, methodHeading);
  if (isText(basis["审稿方法"]) && !methodSection.includes(basis["审稿方法"])) issues.push("报告未镜像审稿方法");

  const detailsSection = report.match(/## 四、评分细则\s*([\s\S]*?)\s*## 五、修改建议/u)?.[1] || "";
  const firstDimensionHeading = `### 1. ${DIMENSIONS[0]}`;
  const firstDimensionIndex = detailsSection.indexOf(firstDimensionHeading);
  const detailsConclusion = firstDimensionIndex < 0 ? "" : detailsSection.slice(0, firstDimensionIndex).trim();
  if (detailsConclusion.length < 40) issues.push("评分细则开篇需要先概括本稿最应关注的维度和具体内容");
  const namedDimensions = DIMENSIONS.filter((name) => detailsConclusion.includes(name));
  if (namedDimensions.length < 2) issues.push("评分细则开篇至少需要点名两个重点维度");
  namedDimensions.forEach((name) => {
    if (!detailsConclusion.includes(`**${name}**`)) issues.push(`评分细则开篇中的“${name}”必须使用 Markdown 加粗`);
  });
  const focusChecks = dimensions
    .flatMap((dimension) => dimension?.["检查项"] || [])
    .map((item) => item?.["检查项"])
    .filter(isText)
    .filter((name) => detailsConclusion.includes(`**${name}**`));
  if (focusChecks.length < 2) {
    issues.push("评分细则开篇需用加粗点名至少两项具体检查项，以标记重点关注行");
  }
  if (/修改建议|验收条件/u.test(detailsSection)) issues.push("评分细则只说明原稿问题，不应提前写修改建议或验收条件");
  if (/^#### /mu.test(detailsSection)) issues.push("每个分析维度只能使用一张完整表格，不应再拆分子表");
  dimensions.forEach((dimension, index) => {
    if (!isPlainObject(dimension)) return;
    const heading = `### ${index + 1}. ${dimension["维度"]}`;
    if (!report.includes(`${heading}\n`)) issues.push(`报告必须以“${heading}”作为维度标题`);
    const section = reportSection(report, heading);
    if (isText(dimension["判断"]) && !section.includes(dimension["判断"])) issues.push(`报告未镜像${dimension["维度"]}的维度判断`);
    if (section.indexOf(dimension["判断"]) < 0 || section.indexOf(DETAIL_TABLE_HEADER) < 0 || section.indexOf(dimension["判断"]) > section.indexOf(DETAIL_TABLE_HEADER)) {
      issues.push(`${dimension["维度"]}必须先写维度结论，再写细则表`);
    }
    const rows = tableRows(section, DETAIL_TABLE_HEADER);
    const items = dimension["检查项"] || [];
    if (rows.length !== items.length) issues.push(`${dimension["维度"]}必须在一张表中镜像全部检查项`);
    items.forEach((item) => {
      const pattern = new RegExp(`\\|\\s*${escapeRegExp(item?.["检查项"])}\\s*\\|\\s*${escapeRegExp(item?.["评级"])}\\s*\\|`, "u");
      if (!pattern.test(section)) issues.push(`报告未镜像${dimension["维度"]}的检查项与评级`);
      if (isText(item?.["问题说明"]) && !section.includes(item["问题说明"])) issues.push(`报告未镜像${dimension["维度"]}检查项的问题说明`);
      (item?.["原稿证据"] || []).forEach((evidence) => {
        if (!reportHasRange(section, evidence["起始行"], evidence["结束行"])) issues.push(`报告未镜像${dimension["维度"]}检查项的正文证据`);
      });
    });
  });

  const repairSection = report.match(/## 五、修改建议\s*([\s\S]*?)\s*## 六、最终结论/u)?.[1] || "";
  const repairConclusion = repairSection.slice(0, repairSection.indexOf("### 1. P0 问题")).trim();
  if (repairConclusion.length < 12) issues.push("修改建议必须先概括本轮问题，再展开 P0/P1");
  const p0Section = repairSection.match(/### 1\. P0 问题\s*([\s\S]*?)\s*### 2\. P1 问题/u)?.[1] || "";
  const p1Section = repairSection.match(/### 2\. P1 问题\s*([\s\S]*)/u)?.[1] || "";
  if (!/^>\s*P0：/mu.test(p0Section)) issues.push("P0 问题标题下必须用引用说明 P0 的含义");
  if (!/^>\s*P1：/mu.test(p1Section)) issues.push("P1 问题标题下必须用引用说明 P1 的含义");
  if (/^- 定位：/mu.test(repairSection) || /验收条件/u.test(repairSection)) issues.push("修改建议不应展示定位或验收条件");
  const p0Items = card["P0问题"] || [];
  if (!p0Items.length && !p0Section.includes("当前未识别 P0 问题")) issues.push("没有 P0 时需要明确写“当前未识别 P0 问题”");
  p0Items.forEach((item, index) => {
    const heading = `#### 1.${index + 1} ${item?.["问题"] || ""}`;
    if (!isText(item?.["问题"]) || !p0Section.includes(heading)) {
      issues.push("报告未镜像 P0 的核心问题标题");
      return;
    }
    const start = p0Section.indexOf(heading) + heading.length;
    const next = p0Section.indexOf("\n#### ", start);
    const section = p0Section.slice(start, next < 0 ? p0Section.length : next);
    [["原稿情况", item["原稿情况"]], ["问题影响", item["影响"]], ["修改建议", item["修改动作"]]].forEach(([label, value]) => {
      if (!section.includes(`- ${label}：`) || (isText(value) && !section.includes(value))) issues.push(`报告中的 P0“${item["问题"]}”未完整镜像${label}`);
    });
  });
  const p1Items = card["P1问题"] || [];
  const p1Bullets = (p1Section.match(/^- .+$/gmu) || []).filter((item) => !item.includes("当前未识别 P1 问题"));
  if (p1Bullets.length !== p1Items.length || p1Bullets.some((item) => item.length > 160)) issues.push("P1 问题必须逐项使用简短的一句话列表");
  if (!p1Items.length && !p1Section.includes("当前未识别 P1 问题")) issues.push("没有 P1 时需要明确写“当前未识别 P1 问题”");
  p1Items.forEach((item) => {
    if (isText(item?.["问题"]) && !p1Section.includes(`- ${item["问题"]}：${item["修改动作"]}`)) issues.push("报告未镜像 P1 的一句话问题");
  });
  const finalSection = report.match(/## 六、最终结论\s*([\s\S]*)$/u)?.[1]?.trim() || "";
  if (!finalSection || (isText(conclusion["下一步"]) && !finalSection.includes(conclusion["下一步"]))) {
    issues.push("最终结论需要镜像明确的编辑结论和下一步处理顺序");
  }
}

export async function validateForeignReviewArtifacts(workspace, input, card, scoring, index, coverage, ledger, report) {
  const info = card["审稿信息"];
  const expectedPath = path.resolve(input.scriptPath);
  const hasScriptReference = isPlainObject(info) && isText(info["剧本文件"]);
  const sourcePath = hasScriptReference ? path.resolve(workspace, info["剧本文件"]) : expectedPath;
  const text = await fs.readFile(expectedPath, "utf8");
  const lines = normalizeLines(text);
  const sourceHash = hashText(text);
  const issues = [];
  if (!hasExactKeys(card, SCORECARD_KEYS)) issues.push("评分卡顶层字段必须与 review-scorecard.json5 一致");
  if (card.schema_version !== SCORECARD_SCHEMA_VERSION) issues.push(`评分卡 schema_version 必须为 ${SCORECARD_SCHEMA_VERSION}`);
  if (hasScriptReference && sourcePath !== expectedPath) issues.push("评分卡引用的剧本文件不是当前待审正文");
  checkReviewInfo(info, sourceHash, issues);
  if (!isPlainObject(index) || index.script_hash !== sourceHash || !Array.isArray(index.units) || !index.units.length) {
    issues.push("审读索引与当前剧本文本不一致，需要重新建立索引");
  }
  if (!isPlainObject(coverage) || coverage.script_hash !== sourceHash || coverage.total_lines !== lines.length
    || !coverage.complete || !Array.isArray(coverage.ranges) || coverage.ranges.length !== 1
    || coverage.ranges[0]?.start !== 1 || coverage.ranges[0]?.end !== lines.length) {
    issues.push("未记录当前正文的完整审读覆盖，不能完成正式审稿");
  }
  checkLedger(ledger, sourceHash, lines, issues);
  if (Array.isArray(index?.units) && Array.isArray(ledger?.units)) {
    const indexedIds = index.units.map((unit) => unit?.id);
    const ledgerIds = ledger.units.map((unit) => unit?.id);
    if (JSON.stringify(ledgerIds) !== JSON.stringify(indexedIds)) issues.push("审读台账必须与当前审读索引的全部单元一一对应");
  }
  const admissionValidation = validateAdmissionGate(card["准入标准"], index, lines);
  if (!admissionValidation.ok) issues.push(...admissionValidation.issues);
  const admissionConclusion = admissionConclusionForItems(card["准入标准"]?.["检查项"]);
  if (admissionConclusion && card["准入标准"]?.["结论"] !== admissionConclusion) {
    issues.push(`准入标准的结论必须由工具归并为“${admissionConclusion}”`);
  }
  const admitted = admissionAllowsScoring(card);
  const scoringValidation = admitted
    ? validateReviewScoringState(scoring, sourceHash)
    : { ok: true, calculated: null, issues: [] };
  if (!scoringValidation.ok) issues.push(...scoringValidation.issues);
  if (!admitted) {
    const containsCalculatedScore = typeof scoring?.["总分"] === "number"
      || (scoring?.["维度"] || []).some((dimension) => typeof dimension?.["得分"] === "number"
        || (dimension?.["检查项"] || []).some((item) => typeof item?.["分数"] === "number"));
    if (containsCalculatedScore) issues.push("准入不通过时不得保留检查项、维度或总体分数");
  }
  const scoringDimensions = scoringValidation.calculated?.["维度"] || [];
  checkNoPublicScores(card, issues);
  checkScriptInformation(card, lines, issues);

  const dimensions = card["六维分析"];
  if (!Array.isArray(dimensions) || dimensions.length !== DIMENSIONS.length) {
    issues.push("评分卡必须包含六维分析");
  } else if (admitted) {
    dimensions.forEach((dimension, index) => {
      const expected = DIMENSIONS[index];
      if (!hasExactKeys(dimension, DIMENSION_KEYS) || dimension["维度"] !== expected) {
        issues.push(`第 ${index + 1} 个评分维度必须是“${expected}”，且字段完整`);
        return;
      }
      if (!GRADES.includes(dimension["评级"])) issues.push(`${expected}的评级必须为 D、C、B、A、S 或 SS`);
      requireText(dimension["判断"], `${expected}的判断`, issues);
      checkInspectionItems(dimension["检查项"], dimension, scoringDimensions[index], lines, issues);
    });
  } else {
    dimensions.forEach((dimension, index) => {
      const expected = DIMENSIONS[index];
      if (!hasExactKeys(dimension, DIMENSION_KEYS) || dimension["维度"] !== expected) {
        issues.push(`第 ${index + 1} 个评分维度必须保留“${expected}”的空白标准结构`);
        return;
      }
      if (dimension["评级"] || dimension["判断"] || dimension["检查项"]?.some((item) => item?.["评级"])) {
        issues.push(`准入不通过时不得保留“${expected}”的评级或维度判断`);
      }
    });
  }

  if (admitted) checkRatingBasis(card["评级依据"], Array.isArray(dimensions) ? dimensions : [], issues);
  const conclusion = card["总体结论"];
  if (!isPlainObject(conclusion)) {
    issues.push("评分卡缺少总体结论");
  } else {
    if (!VERDICTS.includes(conclusion["结论"])) issues.push("总体结论不符合约定范围");
    if (admitted && !isOverallGrade(conclusion["评级"])) issues.push("总体结论的评级必须为 D、C、B、A、S、SS 或带加号的总体评级");
    if (!admitted && conclusion["评级"] !== "未评级") issues.push("准入不通过时不得生成字母评级，总体评级必须为“未评级”");
    if (!admitted && conclusion["结论"] === "通过") issues.push("准入不通过时，审核结论不得为通过");
    ["一句话判断", "建议修改范围", "下一步"].forEach((field) => requireText(conclusion[field], `总体结论的${field}`, issues));
    if (!REPAIR_SCOPES.includes(conclusion["建议修改范围"])) issues.push("总体结论的建议修改范围不符合约定");
    if (admitted && scoringValidation.calculated?.["总体评级"] && conclusion["评级"] !== scoringValidation.calculated["总体评级"]) {
      issues.push("总体结论的评级必须由内部评分计算结果同步");
    }
  }
  if (admitted) {
    checkIssueList(card["P0问题"], "P0", lines, issues);
    checkIssueList(card["P1问题"], "P1", lines, issues);
  } else if (card["P0问题"]?.length || card["P1问题"]?.length) {
    issues.push("准入不通过时不生成 P0/P1，修改建议应直接写入准入标准和最终结论");
  }
  if (!Array.isArray(card["风险与复核"])) issues.push("风险与复核必须是数组");
  else card["风险与复核"].forEach((risk, index) => {
    const label = `风险与复核第 ${index + 1} 项`;
    if (!isPlainObject(risk)) {
      issues.push(`${label}必须是对象`);
      return;
    }
    ["类别", "严重程度", "说明", "建议"].forEach((field) => requireText(risk[field], `${label}的${field}`, issues));
    if (typeof risk["需要人工复核"] !== "boolean") issues.push(`${label}的需要人工复核必须是布尔值`);
  });
  if (admitted && conclusion?.["结论"] === "通过") {
    const grades = Array.isArray(dimensions) ? dimensions.map((item) => item?.["评级"]) : [];
    if (!["A", "S", "SS"].includes(baseGrade(conclusion["评级"])) || grades.includes("D")) issues.push("通过结论要求总体评级至少为 A，且六维没有 D");
    if (card["P0问题"]?.length) issues.push("存在 P0 问题时总体结论不得为通过");
    if (card["风险与复核"]?.some((item) => item?.["严重程度"] === "高" && item?.["需要人工复核"])) issues.push("存在未关闭的高风险人工复核项时总体结论不得为通过");
  }
  if (admitted) checkContentQuality(card, issues);
  checkEditorialCopy(card, issues);
  checkReport(report, card, issues);
  return { ok: !issues.length, issues, sourceHash, lines };
}

export async function checkForeignReview(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const artifactSpecs = [
    { key: "scorecardText", path: path.join(workspaceDir, "review-scorecard.json"), json: true },
    { key: "scoringText", path: path.join(workspaceDir, REVIEW_SCORING_RELATIVE_PATH), json: true },
    { key: "report", path: path.join(workspaceDir, "output", "审稿报告.md"), json: false },
    { key: "index", path: path.join(workspaceDir, "runtime", "review-source-index.json"), json: true },
    { key: "coverage", path: path.join(workspaceDir, "runtime", "review-coverage.json"), json: true },
    { key: "ledger", path: path.join(workspaceDir, "runtime", "review-ledger.json"), json: true }
  ];
  const artifactReads = await Promise.allSettled(artifactSpecs.map((spec) => fs.readFile(spec.path, "utf8")));
  const readErrors = artifactReads.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (readErrors.length) return failedArtifactResult(readErrors);

  const artifactTexts = Object.fromEntries(artifactSpecs.map((spec, index) => [spec.key, artifactReads[index].value]));
  const artifacts = { ...artifactTexts };
  const parseErrors = [];
  for (const spec of artifactSpecs.filter((item) => item.json)) {
    try {
      artifacts[spec.key] = JSON.parse(artifacts[spec.key]);
    } catch (error) {
      const parseError = new Error(`${spec.path} 不是有效 JSON：${error.message}`);
      parseError.code = "INVALID_JSON";
      parseError.path = spec.path;
      parseErrors.push(parseError);
    }
  }
  if (parseErrors.length) return failedArtifactResult(parseErrors);

  const [context, input] = await Promise.all([
    resolveProjectReviewContext(workspaceDir),
    resolveReviewInput(workspaceDir)
  ]);
  const { scorecardText, scoringText, report } = artifactTexts;
  const { index, coverage, ledger } = artifacts;
  if (context) assertDistributionBriefComplete(context.project);
  const fullScript = await fs.readFile(input.scriptPath, "utf8");
  if (!fullScript.trim()) throw new Error(`${input.scriptRelativePath} 不存在或内容为空`);
  const artifactHashes = reviewDecisionArtifactHashes({
    scriptRelativePath: input.scriptRelativePath,
    fullScript,
    scorecardText,
    scoringText,
    report
  });
  const recorded = context ? existingReviewDecision(context.progress, artifactHashes) : null;
  if (recorded) return { ...recorded, scorecard_file: path.join(workspaceDir, "review-scorecard.json"), report_file: path.join(workspaceDir, "output", "审稿报告.md") };
  if (context && !context.reviewOnly) {
    if (context.progress?.stages?.full_generate?.status !== "completed") throw new Error("full_generate 尚未完成");
    if (context.project.requires_translation !== false && context.progress?.stages?.dialogue_translate?.status !== "completed") throw new Error("dialogue_translate 尚未完成");
  }

  const card = artifacts.scorecardText;
  const scoring = artifacts.scoringText;
  const validation = await validateForeignReviewArtifacts(workspaceDir, input, card, scoring, index, coverage, ledger, report);
  if (!validation.ok) {
    return {
      ok: false,
      issue_count: validation.issues.length,
      issues: validation.issues,
      repair_instructions: repairInstructions(validation.issues, card),
      next_action: "按 repair_instructions 中每一项的 action 修复全部问题；无需读取检查工具源码。"
    };
  }
  const verdict = card["总体结论"];
  const outputFiles = ["review-scorecard.json", "output/审稿报告.md"];
  if (!context) {
    return { ok: true, outcome: "complete", review_only: true, verdict: verdict["结论"], scorecard_file: path.join(workspaceDir, "review-scorecard.json"), report_file: path.join(workspaceDir, "output", "审稿报告.md") };
  }
  const requestedRepairScope = verdict["建议修改范围"];
  const revisionStage = verdict["结论"] === "通过"
    ? null
    : context.project?.task_type === "rewrite" && requestedRepairScope === "剧本前段"
      ? "full_generate"
      : REPAIR_STAGE[requestedRepairScope];
  const decision = {
    outcome: verdict["结论"] === "通过" ? "passed" : "revision_requested",
    verdict: verdict["结论"],
    revision_stage: revisionStage,
    reason: `海外审稿结论：${verdict["结论"]}；${verdict["一句话判断"]}`,
    artifact_hashes: artifactHashes,
  };
  if (context.reviewOnly || decision.outcome === "passed") {
    if (context.reviewOnly && context.progress?.stages?.full_generate?.status !== "completed") {
      await updateProgress({ workspace: workspaceDir, stage: "full_generate", status: "completed", updatedBy, nextSkill: "foreign_review", outputFiles: [input.scriptRelativePath] });
    }
    await recordReviewDecision({ workspace: workspaceDir, status: "awaiting_approval", updatedBy, outputFiles, decision });
    return { ok: true, outcome: "awaiting_approval", review_only: context.reviewOnly, verdict: verdict["结论"], review_decision: decision.outcome, scorecard_file: path.join(workspaceDir, "review-scorecard.json"), report_file: path.join(workspaceDir, "output", "审稿报告.md") };
  }
  await recordReviewDecision({ workspace: workspaceDir, status: "completed", updatedBy, outputFiles, decision });
  return { ok: true, outcome: "revision_requested", verdict: verdict["结论"], revision_stage: revisionStage, review_decision: decision.outcome, scorecard_file: path.join(workspaceDir, "review-scorecard.json"), report_file: path.join(workspaceDir, "output", "审稿报告.md") };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await checkForeignReview(args.workspace, args.updatedBy);
    if (!result.ok) {
      process.stderr.write(`${JSON.stringify({ ...result, stage: "foreign_review", tool: "check" }, null, 2)}\n`);
      process.exitCode = 1;
    } else if (result.outcome === "revision_requested") {
      process.stdout.write(`${JSON.stringify({ ...result, message: "海外审稿已完成，报告提出了调整建议。", next_action: "保留当前文件状态。请查看审稿报告，并在对应文件中手动重新生成；完成后重新审稿。" }, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ ...result, message: "海外审稿已通过检查。", next_action: result.outcome === "complete" ? "交付审稿报告并等待下一步确认。" : "请用户确认审稿报告；确认后项目完成。" }, null, 2)}\n`);
    }
  } catch (error) {
    const instruction = runtimeFailureInstruction(error);
    process.stderr.write(`${JSON.stringify({
      ok: false,
      stage: "foreign_review",
      tool: "check",
      issue_count: 1,
      issues: [instruction.message],
      repair_instructions: [instruction],
      next_action: "按 repair_instructions 中的 action 修复后重新检查。"
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
