#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateProgress } from "../../../tools/update-progress.mjs";
import {
  PLACEHOLDER_PREFIX,
  hashText,
  readManifestUnits,
  readTranslationManifest,
  validateRenderedScript,
  validateSynopsisTranslation,
  validateTranslationUnits
} from "./dialogue-translate-utils.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]] = argv[index + 1];
  if (!args["--workspace"] || !args["--updated-by"] || Object.keys(args).some((key) => !["--workspace", "--updated-by", "--hard-only"].includes(key))) {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, args["--workspace"]), updatedBy: args["--updated-by"] || "admin" };
}

export async function checkDialogueTranslation(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const manifest = await readTranslationManifest(workspaceDir);
  const [progress, userInput, sourceText, outputText, units] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, manifest.source_file), "utf8"),
    fs.readFile(path.join(workspaceDir, manifest.output_file), "utf8").catch(() => ""),
    readManifestUnits(workspaceDir, manifest)
  ]);
  const issues = [];
  const taskType = userInput.project?.task_type || "rewrite";
  if (["rewrite", "novel", "replicate"].includes(taskType) && progress.stages?.full_generate?.status !== "completed") issues.push("full_generate 尚未完成");
  if (hashText(sourceText) !== manifest.source_hash) issues.push("待翻译剧本已变化，需要重新初始化台词翻译");
  const validation = validateTranslationUnits(units, manifest.source_dialogues || [], manifest.source_episode_titles);
  issues.push(...validation.issues);
  const synopsisValidation = validateSynopsisTranslation(units, manifest.story_synopsis);
  issues.push(...synopsisValidation.issues);
  if (manifest.story_synopsis) {
    const currentOutline = await fs.readFile(path.join(workspaceDir, "3.1-outline.json"), "utf8").then(JSON.parse).catch(() => null);
    const currentSynopsis = typeof currentOutline?.["故事梗概"] === "string" ? currentOutline["故事梗概"].trim() : "";
    if (hashText(currentSynopsis) !== manifest.story_synopsis.source_hash) {
      issues.push("故事梗概已变化，需要重新初始化台词翻译");
    }
    if (manifest.story_synopsis.translated_text !== synopsisValidation.translation) {
      issues.push("英文简介尚未合并到台词翻译清单，请重新合并");
    }
  }
  if (!outputText.trim()) issues.push("台词译稿不存在或为空");
  else {
    if (outputText.includes(PLACEHOLDER_PREFIX)) issues.push("台词译稿仍包含未替换的翻译占位符");
    issues.push(...validateRenderedScript(
      outputText,
      manifest.source_dialogues || [],
      manifest.source_episode_titles,
      validation.episodeTitleTranslations
    ));
  }
  if (issues.length) return { ok: false, issues: [...new Set(issues)] };
  const nextSkill = ["rewrite", "novel", "replicate"].includes(taskType) ? "foreign_review" : "";
  await updateProgress({
    workspace: workspaceDir,
    stage: "dialogue_translate",
    status: "completed",
    updatedBy,
    nextSkill,
    outputFiles: [manifest.output_file]
  });
  return { ok: true, output_file: path.join(workspaceDir, manifest.output_file), dialogue_count: validation.translations.size, next_skill: nextSkill };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await checkDialogueTranslation(args.workspace, args.updatedBy);
    if (!result.ok) {
      process.stderr.write(`${JSON.stringify({ ...result, stage: "dialogue_translate", tool: "check", next_action: "按台词ID或英文简介修复翻译单元，重新合并后再检查。" }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ ...result, message: "台词译稿已通过检查。", next_action: result.next_skill ? "可以执行 foreign_review。" : "台词译稿可以交付。" }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "dialogue_translate", tool: "check", message: error.message, next_action: "检查台词翻译清单、单元文件和用户译稿后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
