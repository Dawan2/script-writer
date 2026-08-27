#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  dialogueTranslationHeading,
  dialogueTranslationRelativePath,
  englishScriptTitleIssue,
  fullScriptHeading,
  fullScriptRelativePath,
  outlineDocumentHeading,
  outlineDocumentRelativePath,
  rewrittenTitleIssue,
  shouldRenameScriptTitle,
  shouldIncludeEnglishScriptTitle
} from "./script-artifacts.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function relativePath(workspace, filePath) {
  const value = path.relative(workspace, filePath).split(path.sep).join("/");
  if (!value || value === "." || value.startsWith("../") || path.isAbsolute(value)) {
    throw new Error("文件必须位于当前项目目录内");
  }
  return value;
}

async function readRequiredJson(workspace, relative) {
  const filePath = path.join(workspace, relative);
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    throw new Error(`${relative}不存在或无法读取`);
  }
  try {
    return { filePath, value: JSON.parse(text), text };
  } catch {
    throw new Error(`${relative}不是有效 JSON`);
  }
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readOptionalJson(workspace, relative) {
  const filePath = path.join(workspace, relative);
  const text = await readOptionalText(filePath);
  if (text === null) return null;
  try {
    return { filePath, value: JSON.parse(text), text };
  } catch {
    throw new Error(`${relative}不是有效 JSON`);
  }
}

function replaceFirstDocumentHeading(content, heading, label) {
  const lines = content.split(/\r?\n/u);
  const index = lines.findIndex((line) => /^#(?!#)\s+\S/u.test(line));
  if (index < 0) throw new Error(`${label}缺少可同步的文档标题`);
  lines[index] = heading;
  return lines.join("\n");
}

function replaceReviewReportTitle(content, title) {
  const lines = replaceFirstDocumentHeading(content, `# 《${title}》审稿报告`, "审稿报告").split("\n");
  const informationLine = lines.findIndex((line) => /^\s*-\s*剧集名称：/u.test(line));
  if (informationLine >= 0) lines[informationLine] = `- 剧集名称：${title}`;
  return lines.join("\n");
}

function replaceKnownPath(value, replacements) {
  return typeof value === "string" && replacements.has(value) ? replacements.get(value) : value;
}

function ensureTitle(title, englishTitle, userInput) {
  if (!isObject(userInput?.project)) throw new Error("1.1-user-input.json 缺少项目资料");
  const project = userInput.project;
  if (!shouldRenameScriptTitle(project)) {
    throw new Error("剧本名称只能在剧本改写项目的故事梗概中维护");
  }
  const titleIssue = rewrittenTitleIssue(title, project.source_script?.display_name);
  if (titleIssue) throw new Error(titleIssue);
  const requiresEnglishTitle = shouldIncludeEnglishScriptTitle(project);
  const englishIssue = englishScriptTitleIssue(englishTitle, { requiresEnglishTitle });
  if (englishIssue) throw new Error(englishIssue);
  return requiresEnglishTitle;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("请使用 --workspace <项目目录> --title <中文剧本名称> [--english-title <英文剧本名称>] --updated-by <用户>");
    const name = key.slice(2);
    if (!new Set(["workspace", "title", "english-title", "updated-by"]).has(name) || Object.hasOwn(args, name)) {
      throw new Error(`不支持或重复的参数：${key}`);
    }
    args[name] = value;
  }
  if (!args.workspace || !args.title || !args["updated-by"]) {
    throw new Error("请使用 --workspace <项目目录> --title <中文剧本名称> [--english-title <英文剧本名称>] --updated-by <用户>");
  }
  return {
    workspace: path.resolve(agentRoot, args.workspace),
    title: args.title.trim(),
    englishTitle: (args["english-title"] || "").trim(),
    updatedBy: args["updated-by"].trim() || "admin"
  };
}

async function applyChanges(changes) {
  const sourcePaths = new Map();
  const targetPaths = new Set();
  for (const change of changes) {
    if (sourcePaths.has(change.source) || targetPaths.has(change.target)) {
      throw new Error("标题同步包含重复的文件更新");
    }
    sourcePaths.set(change.source, null);
    targetPaths.add(change.target);
  }

  for (const change of changes) {
    if (change.source === change.target) continue;
    const targetExists = await fs.stat(change.target).then(() => true).catch(() => false);
    if (targetExists && !sourcePaths.has(change.target)) {
      throw new Error(`目标文件已存在，无法同步名称：${relativePath(change.workspace, change.target)}`);
    }
  }

  const token = randomUUID();
  const originals = new Map();
  const staged = [];
  const backups = [];
  const movedTargets = [];
  try {
    for (const source of sourcePaths.keys()) {
      originals.set(source, await readOptionalText(source));
    }
    for (const change of changes) {
      await fs.mkdir(path.dirname(change.target), { recursive: true });
      const temporary = path.join(path.dirname(change.target), `.${path.basename(change.target)}.${token}.tmp`);
      await fs.writeFile(temporary, change.content, "utf8");
      staged.push({ ...change, temporary });
    }
    for (const source of sourcePaths.keys()) {
      if (originals.get(source) === null) continue;
      const backup = path.join(path.dirname(source), `.${path.basename(source)}.${token}.backup`);
      await fs.rename(source, backup);
      backups.push({ source, backup });
    }
    for (const change of staged) {
      await fs.rename(change.temporary, change.target);
      movedTargets.push(change.target);
    }
    await Promise.all(backups.map(({ backup }) => fs.unlink(backup).catch(() => undefined)));
  } catch (error) {
    await Promise.all(staged.map(({ temporary }) => fs.unlink(temporary).catch(() => undefined)));
    await Promise.all(movedTargets.map((target) => fs.unlink(target).catch(() => undefined)));
    await Promise.all(backups.map(async ({ source, backup }) => {
      const exists = await fs.stat(backup).then(() => true).catch(() => false);
      if (exists) await fs.rename(backup, source);
    }));
    await Promise.all([...originals.entries()].map(async ([source, content]) => {
      if (content === null) return;
      const exists = await fs.stat(source).then(() => true).catch(() => false);
      if (!exists) await fs.writeFile(source, content, "utf8");
    }));
    throw error;
  }
}

export async function renameScriptTitle({ workspace, title, englishTitle = "", updatedBy = "admin" }) {
  const workspaceDir = path.resolve(workspace);
  const [userInputFile, outlineFile, progressFile] = await Promise.all([
    readRequiredJson(workspaceDir, "1.1-user-input.json"),
    readRequiredJson(workspaceDir, "3.1-outline.json"),
    readRequiredJson(workspaceDir, "1.2-project-progress.json")
  ]);
  if (!isObject(outlineFile.value)) throw new Error("3.1-outline.json 顶层必须是对象");
  if (!isObject(progressFile.value)) throw new Error("1.2-project-progress.json 顶层必须是对象");

  const requiresEnglishTitle = ensureTitle(title, englishTitle, userInputFile.value);
  const oldOutline = outlineFile.value;
  const oldTitle = typeof oldOutline["剧本名称"] === "string" ? oldOutline["剧本名称"].trim() : "";
  if (!oldTitle) throw new Error("剧本大纲尚未生成新的剧本名称");

  const nextOutline = { ...oldOutline, "剧本名称": title, "英文剧本名称": requiresEnglishTitle ? englishTitle : "" };
  const nextUserInput = structuredClone(userInputFile.value);
  nextUserInput.project.project_name = title;

  const oldPaths = {
    outline: outlineDocumentRelativePath(oldOutline),
    full: fullScriptRelativePath(oldOutline),
    dialogue: dialogueTranslationRelativePath(oldOutline, userInputFile.value)
  };
  const nextPaths = {
    outline: outlineDocumentRelativePath(nextOutline),
    full: fullScriptRelativePath(nextOutline),
    dialogue: dialogueTranslationRelativePath(nextOutline, nextUserInput)
  };
  const replacements = new Map(Object.entries(oldPaths).map(([key, oldPath]) => [oldPath, nextPaths[key]]));
  const changes = [];
  const stagedContent = new Map();
  const touchedStages = new Set(["outline_rewrite"]);

  function addChange(source, target, content, label) {
    changes.push({ workspace: workspaceDir, source, target, content, label });
    stagedContent.set(target, content);
  }

  function plannedText(relative) {
    const target = path.join(workspaceDir, relative);
    return stagedContent.get(target);
  }

  function hasPlannedFile(relative) {
    return stagedContent.has(path.join(workspaceDir, relative));
  }

  addChange(outlineFile.filePath, outlineFile.filePath, jsonText(nextOutline), "剧本大纲资料");

  const outlineMarkdownPath = path.join(workspaceDir, oldPaths.outline);
  const outlineMarkdown = await readOptionalText(outlineMarkdownPath);
  if (outlineMarkdown === null) throw new Error("故事梗概文件不存在，无法同步剧本名称");
  addChange(
    outlineMarkdownPath,
    path.join(workspaceDir, nextPaths.outline),
    replaceFirstDocumentHeading(outlineMarkdown, outlineDocumentHeading(nextOutline), "故事梗概"),
    "故事梗概"
  );

  const fullMarkdownPath = path.join(workspaceDir, oldPaths.full);
  const fullMarkdown = await readOptionalText(fullMarkdownPath);
  if (fullMarkdown !== null) {
    touchedStages.add("full_generate");
    addChange(
      fullMarkdownPath,
      path.join(workspaceDir, nextPaths.full),
      replaceFirstDocumentHeading(fullMarkdown, fullScriptHeading(nextOutline), "剧本全稿"),
      "剧本全稿"
    );
  }

  const dialogueMarkdownPath = path.join(workspaceDir, oldPaths.dialogue);
  const dialogueMarkdown = await readOptionalText(dialogueMarkdownPath);
  if (dialogueMarkdown !== null) {
    touchedStages.add("dialogue_translate");
    addChange(
      dialogueMarkdownPath,
      path.join(workspaceDir, nextPaths.dialogue),
      replaceFirstDocumentHeading(dialogueMarkdown, dialogueTranslationHeading(nextOutline, nextUserInput), "台词译稿"),
      "台词译稿"
    );
  }

  const manifestFile = await readOptionalJson(workspaceDir, "runtime/dialogue-translate/manifest.json");
  if (manifestFile) {
    if (!isObject(manifestFile.value)) throw new Error("台词翻译清单格式无效");
    const fullText = plannedText(nextPaths.full);
    if (!fullText) throw new Error("台词翻译清单存在，但剧本全稿不存在");
    const nextManifest = {
      ...manifestFile.value,
      source_file: nextPaths.full,
      source_hash: hashText(fullText),
      output_file: nextPaths.dialogue,
      output_heading: dialogueTranslationHeading(nextOutline, nextUserInput)
    };
    touchedStages.add("dialogue_translate");
    addChange(manifestFile.filePath, manifestFile.filePath, jsonText(nextManifest), "台词翻译清单");
  }

  const scorecardFile = await readOptionalJson(workspaceDir, "review-scorecard.json");
  const reviewIndexFile = await readOptionalJson(workspaceDir, "runtime/review-source-index.json");
  const reviewCoverageFile = await readOptionalJson(workspaceDir, "runtime/review-coverage.json");
  const reviewLedgerFile = await readOptionalJson(workspaceDir, "runtime/review-ledger.json");
  const reviewScoringFile = await readOptionalJson(workspaceDir, "runtime/review-scoring.json");
  const reviewReportPath = path.join(workspaceDir, "output/审稿报告.md");
  const reviewReport = await readOptionalText(reviewReportPath);
  const hasReviewState = Boolean(scorecardFile || reviewIndexFile || reviewCoverageFile || reviewLedgerFile || reviewScoringFile || reviewReport !== null);

  if (hasReviewState) {
    const dialogueStage = progressFile.value.stages?.dialogue_translate;
    const reviewScript = dialogueStage?.status === "completed" && hasPlannedFile(nextPaths.dialogue)
      ? nextPaths.dialogue
      : nextPaths.full;
    const reviewScriptText = plannedText(reviewScript);
    if (!reviewScriptText) throw new Error("审稿资料存在，但当前待审剧本不存在");
    const reviewScriptHash = hashText(reviewScriptText);
    touchedStages.add("foreign_review");

    if (scorecardFile) {
      if (!isObject(scorecardFile.value)) throw new Error("review-scorecard.json 格式无效");
      const nextScorecard = structuredClone(scorecardFile.value);
      if (isObject(nextScorecard["剧本信息"])) nextScorecard["剧本信息"]["剧本名称"] = title;
      if (isObject(nextScorecard["审稿信息"])) {
        nextScorecard["审稿信息"]["剧本文件"] = reviewScript;
        nextScorecard["审稿信息"]["剧本哈希"] = reviewScriptHash;
        if (Array.isArray(nextScorecard["审稿信息"]["可用材料"])) {
          nextScorecard["审稿信息"]["可用材料"] = nextScorecard["审稿信息"]["可用材料"].map((item) => replaceKnownPath(item, replacements));
        }
      }
      addChange(scorecardFile.filePath, scorecardFile.filePath, jsonText(nextScorecard), "审稿评分卡");
    }
    if (reviewIndexFile) {
      if (!isObject(reviewIndexFile.value)) throw new Error("审读索引格式无效");
      addChange(reviewIndexFile.filePath, reviewIndexFile.filePath, jsonText({
        ...reviewIndexFile.value,
        script_path: reviewScript,
        script_hash: reviewScriptHash
      }), "审读索引");
    }
    if (reviewCoverageFile) {
      if (!isObject(reviewCoverageFile.value)) throw new Error("审读覆盖记录格式无效");
      addChange(reviewCoverageFile.filePath, reviewCoverageFile.filePath, jsonText({
        ...reviewCoverageFile.value,
        script_hash: reviewScriptHash
      }), "审读覆盖记录");
    }
    if (reviewLedgerFile) {
      if (!isObject(reviewLedgerFile.value)) throw new Error("审读台账格式无效");
      addChange(reviewLedgerFile.filePath, reviewLedgerFile.filePath, jsonText({
        ...reviewLedgerFile.value,
        script_hash: reviewScriptHash
      }), "审读台账");
    }
    if (reviewScoringFile) {
      if (!isObject(reviewScoringFile.value)) throw new Error("内部评分状态格式无效");
      addChange(reviewScoringFile.filePath, reviewScoringFile.filePath, jsonText({
        ...reviewScoringFile.value,
        "剧本哈希": reviewScriptHash
      }), "内部评分状态");
    }
    if (reviewReport !== null) {
      addChange(reviewReportPath, reviewReportPath, replaceReviewReportTitle(reviewReport, title), "审稿报告");
    }
  }

  const nextProgress = structuredClone(progressFile.value);
  const now = new Date().toISOString();
  if (!isObject(nextProgress.stages)) nextProgress.stages = {};
  const currentOutlineStage = isObject(nextProgress.stages.outline_rewrite)
    ? nextProgress.stages.outline_rewrite
    : {};
  nextProgress.stages.outline_rewrite = {
    ...currentOutlineStage,
    title_confirmation: {
      status: "confirmed",
      title,
      english_title: requiresEnglishTitle ? englishTitle : ""
    }
  };
  for (const stage of Object.values(nextProgress.stages)) {
    if (!isObject(stage) || !Array.isArray(stage.output_files)) continue;
    stage.output_files = stage.output_files.map((file) => replaceKnownPath(file, replacements));
  }
  for (const stageName of touchedStages) {
    if (!isObject(nextProgress.stages[stageName])) continue;
    nextProgress.stages[stageName].updated_at = now;
    nextProgress.stages[stageName].updated_by = updatedBy;
  }
  const reviewDecision = nextProgress.stages?.foreign_review?.review_decision;
  if (isObject(reviewDecision) && isObject(reviewDecision.artifact_hashes)) {
    const nextHashes = {};
    for (const [file, hash] of Object.entries(reviewDecision.artifact_hashes)) {
      const nextFile = replaceKnownPath(file, replacements);
      const content = plannedText(nextFile);
      nextHashes[nextFile] = content === undefined ? hash : hashText(content);
    }
    reviewDecision.artifact_hashes = nextHashes;
  }
  nextProgress.audit = {
    ...(isObject(nextProgress.audit) ? nextProgress.audit : {}),
    updated_at: now,
    updated_by: updatedBy
  };
  nextUserInput.audit = {
    ...(isObject(nextUserInput.audit) ? nextUserInput.audit : {}),
    updated_at: now,
    updated_by: updatedBy
  };
  addChange(progressFile.filePath, progressFile.filePath, jsonText(nextProgress), "项目进度");
  addChange(userInputFile.filePath, userInputFile.filePath, jsonText(nextUserInput), "项目资料");

  const deduplicated = [];
  const bySource = new Map();
  for (const change of changes) {
    if (bySource.has(change.source)) {
      const existing = bySource.get(change.source);
      if (existing.target !== change.target || existing.content !== change.content) {
        throw new Error(`同一文件被重复更新：${change.label}`);
      }
      continue;
    }
    bySource.set(change.source, change);
    deduplicated.push(change);
  }
  await applyChanges(deduplicated);
  return {
    ok: true,
    title,
    english_title: requiresEnglishTitle ? englishTitle : "",
    output_files: {
      outline: nextPaths.outline,
      ...(fullMarkdown !== null ? { full_script: nextPaths.full } : {}),
      ...(dialogueMarkdown !== null ? { dialogue_translation: nextPaths.dialogue } : {})
    },
    updated_files: deduplicated.map((change) => relativePath(workspaceDir, change.target))
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await renameScriptTitle(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ...result, message: "剧本名称及已生成内容已同步。", next_action: "继续使用当前项目，无需重新生成内容。" }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "rename-script-title", message: error.message, next_action: "修复名称、文件冲突或相关资料后重新同步。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
