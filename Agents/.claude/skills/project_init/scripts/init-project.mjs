#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDistributionBrief } from "../../../tools/distribution-brief.mjs";
import { resolveRegionRules } from "../../../tools/get-region-rules.mjs";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { convertScriptToMarkdown } from "./convert-script-to-md.mjs";
import { validateProjectWorkspace } from "./validate-project.mjs";

const SUPPORTED_TEXT_TYPES = new Set(["pdf", "docx", "epub", "txt", "md", "markdown"]);
const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function parseArgs(argv) {
  const args = { attachment: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error("无法识别参数：" + key);
    const name = key.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || (value === "" && name !== "extra-requirements")) {
      throw new Error("缺少 --" + name + " 的值");
    }
    if (name === "attachment") args.attachment.push(value);
    else if (args[name] !== undefined) throw new Error("参数 --" + name + " 不能重复");
    else args[name] = value;
    index += 1;
  }
  if (args["source-file"]) {
    if (args["script-file"]) throw new Error("--source-file 与 --script-file 不能同时使用");
    args["script-file"] = args["source-file"];
  }
  args["extra-requirements"] ??= "";
  return args;
}

function safeDirectoryPart(value, label) {
  const normalized = String(value || "").trim().replace(/\s+/gu, " ")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-");
  if (!normalized || normalized === "." || normalized === "..") throw new Error(label + "不能为空或非法");
  return normalized.slice(0, 80);
}

function shanghaiDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return value.year + "-" + value.month + "-" + value.day;
}

async function createWorkspaceDirectory(workspaceRoot, baseName) {
  await fs.mkdir(workspaceRoot, { recursive: true });
  for (let suffix = 1; ; suffix += 1) {
    const workspaceName = suffix === 1 ? baseName : baseName + "-" + suffix;
    const workspaceDir = path.join(workspaceRoot, workspaceName);
    try {
      await fs.mkdir(workspaceDir);
      return { workspaceName, workspaceDir };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

function relativeReference(fileName) {
  return path.posix.join("references", fileName);
}

function uniqueFileName(fileName, usedNames) {
  const extension = path.extname(fileName);
  const baseName = extension ? fileName.slice(0, -extension.length) : fileName;
  let candidate = fileName;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = baseName + "-" + suffix + extension;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

async function archiveFile(sourcePath, referencesDir, usedNames) {
  const absolutePath = path.resolve(sourcePath);
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) throw new Error("附件不存在或不是文件：" + sourcePath);
  const originalName = path.basename(absolutePath);
  const storedName = uniqueFileName(originalName, usedNames);
  await fs.copyFile(absolutePath, path.join(referencesDir, storedName));
  return {
    original_name: originalName,
    reference_path: relativeReference(storedName),
    file_type: path.extname(originalName).slice(1).toLowerCase() || "unknown"
  };
}

async function archiveAttachment(sourcePath, referencesDir, usedNames) {
  const attachment = await archiveFile(sourcePath, referencesDir, usedNames);
  if (!SUPPORTED_TEXT_TYPES.has(attachment.file_type)) {
    return { ...attachment, text_status: "unsupported", text_path: "" };
  }
  const sourcePathInWorkspace = path.join(referencesDir, path.basename(attachment.reference_path));
  const base = path.basename(attachment.reference_path, path.extname(attachment.reference_path));
  const textName = uniqueFileName(base + "-文本.md", usedNames);
  const textPath = path.join(referencesDir, textName);
  try {
    const conversion = await convertScriptToMarkdown(sourcePathInWorkspace, textPath, {
      title: path.basename(attachment.original_name, path.extname(attachment.original_name))
    });
    return {
      ...attachment,
      text_status: "available",
      text_path: relativeReference(textName),
      converter: conversion.converter
    };
  } catch {
    return { ...attachment, text_status: "unavailable", text_path: "" };
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function stagePreferencesMemory(now, actor) {
  return {
    schema_version: "1.0.0",
    preferences: {},
    audit: {
      created_at: now,
      created_by: actor,
      updated_at: now,
      updated_by: actor
    }
  };
}

function nextSkillForTaskType(taskType) {
  if (taskType === "translate") return "dialogue_translate";
  if (taskType === "review") return "foreign_review";
  if (taskType === "humanize") return "humanizer_zh";
  if (taskType === "novel") return "novel_analysis";
  return "world_view";
}

function normalizedSourceOutputPath(taskType) {
  if (taskType === "novel") return "runtime/原始小说.md";
  if (taskType === "replicate") return "output/爆款分析报告.md";
  return "output/原始剧本.md";
}

export async function initializeProject(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  for (const field of ["project-name", "script-file", "target-region"]) {
    if (!args[field]?.trim()) throw new Error("缺少 --" + field + " 参数");
  }

  const projectName = args["project-name"].trim();
  const createdBy = (args["created-by"] || "admin").trim() || "admin";
  const scriptPath = path.resolve(args["script-file"]);
  const scriptType = path.extname(scriptPath).slice(1).toLowerCase();
  if (!SUPPORTED_TEXT_TYPES.has(scriptType)) {
    throw new Error("上传内容仅支持 pdf、docx、epub、txt、md 或 markdown 格式");
  }
  const taskType = args["task-type"] || "rewrite";
  const region = await resolveRegionRules(args["target-region"]);
  const distributionBrief = buildDistributionBrief({
    targetCountry: region.default_market,
    targetLocale: region.default_locale,
    episodeDuration: args["episode-duration"],
    targetEpisodeCount: args["target-episode-count"],
    maturityTarget: args["maturity-target"],
    theme: args.theme,
    setting: args.setting,
    background: args.background,
    audience: args.audience,
    taskType,
    defaultLocale: region.default_locale
  });

  const workspaceBaseName = shanghaiDate() + "_" + safeDirectoryPart(createdBy, "创建人") + "_" + safeDirectoryPart(projectName, "项目名称");
  const workspaceRoot = path.join(agentRoot, "workspaces");
  const { workspaceName, workspaceDir } = await createWorkspaceDirectory(workspaceRoot, workspaceBaseName);

  const now = new Date().toISOString();
  try {
    const referencesDir = path.join(workspaceDir, "references");
    const memoryDir = path.join(workspaceDir, "memory");
    await Promise.all([fs.mkdir(referencesDir, { recursive: true }), fs.mkdir(memoryDir, { recursive: true })]);
    const usedNames = new Set();
    const sourceScript = await archiveFile(scriptPath, referencesDir, usedNames);
    const sourceFileTitle = path.basename(scriptPath, path.extname(scriptPath)).trim();
    const sourceTitle = (args["source-title"] || sourceFileTitle).trim() || projectName;
    const scriptOutputPath = normalizedSourceOutputPath(taskType);
    const conversion = await convertScriptToMarkdown(
      path.join(workspaceDir, sourceScript.reference_path),
      path.join(workspaceDir, scriptOutputPath),
      { title: sourceTitle }
    );
    const attachments = [];
    const archivedSources = new Set([scriptPath]);
    for (const attachment of args.attachment) {
      const absolutePath = path.resolve(attachment);
      if (archivedSources.has(absolutePath)) continue;
      archivedSources.add(absolutePath);
      attachments.push(await archiveAttachment(absolutePath, referencesDir, usedNames));
    }

    const extraRequirements = (args["extra-requirements"] || "").trim();
    const project = {
      project_name: projectName,
      task_type: taskType,
      workspace: path.posix.join("workspaces", workspaceName),
      target_region: region.key,
      target_language: distributionBrief.target_locale,
      requires_translation: region.requires_translation,
      distribution_brief: distributionBrief,
      source_script: {
        ...sourceScript,
        display_name: sourceTitle,
        output_path: scriptOutputPath,
        converter: conversion.converter
      },
      attachments
    };
    if (extraRequirements) project.extra_requirements = extraRequirements;

    const userInput = {
      schema_version: "1.1.0",
      project,
      status: "project_init:pending",
      audit: {
        created_at: now,
        created_by: createdBy,
        updated_at: now,
        updated_by: createdBy
      }
    };
    const progress = {
      schema_version: "1.1.0",
      status: "project_init:pending",
      current_skill: "project_init",
      next_skill: "",
      stages: {
        project_init: { status: "pending" },
        novel_analysis: { status: "pending" },
        world_view: { status: "pending" },
        outline_rewrite: { status: "pending" },
        character_rewrite: { status: "pending" },
        trial_generate: { status: "pending" },
        full_generate: { status: "pending" },
        dialogue_translate: { status: region.requires_translation ? "pending" : "skipped" },
        foreign_review: { status: "pending" },
        humanizer_zh: { status: "pending" }
      },
      audit: {
        created_at: now,
        created_by: createdBy,
        updated_at: now,
        updated_by: createdBy
      }
    };
    await Promise.all([
      writeJson(path.join(workspaceDir, "1.1-user-input.json"), userInput),
      writeJson(path.join(workspaceDir, "1.2-project-progress.json"), progress),
      writeJson(path.join(memoryDir, "stage-preferences.json"), stagePreferencesMemory(now, createdBy))
    ]);
    const readyForCreation = distributionBrief.status === "complete";
    const attachmentOutputs = attachments.flatMap((attachment) => [attachment.reference_path, attachment.text_path].filter(Boolean));
    await updateProgress({
      workspace: workspaceDir,
      stage: "project_init",
      status: readyForCreation ? "completed" : "needs_revision",
      updatedBy: createdBy,
      nextSkill: readyForCreation
        ? nextSkillForTaskType(project.task_type)
        : "",
      outputFiles: [
        "1.1-user-input.json",
        "1.2-project-progress.json",
        "memory/stage-preferences.json",
        sourceScript.reference_path,
        scriptOutputPath,
        ...attachmentOutputs
      ]
    });
    const validation = await validateProjectWorkspace(workspaceDir);
    return {
      ok: true,
      workspace_dir: workspaceDir,
      user_input: path.join(workspaceDir, "1.1-user-input.json"),
      progress: path.join(workspaceDir, "1.2-project-progress.json"),
      normalized_source: path.join(workspaceDir, scriptOutputPath),
      references: [sourceScript.reference_path, ...attachmentOutputs],
      distribution_brief_status: distributionBrief.status,
      distribution_brief_missing_fields: distributionBrief.missing_fields,
      next_action: readyForCreation
        ? `项目初始化完成，可以执行 ${nextSkillForTaskType(project.task_type)}。`
        : "发行任务书尚未完成，请补齐并确认后再进入内容处理。",
      validation
    };
  } catch (error) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  initializeProject().then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }).catch((error) => {
    process.stderr.write(JSON.stringify({
      ok: false,
      stage: "project_init",
      tool: "init",
      message: error.message,
      next_action: "修正输入后重新初始化；失败目录已删除。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  });
}
