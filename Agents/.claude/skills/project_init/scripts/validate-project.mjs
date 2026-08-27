#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeLocale } from "../../../tools/distribution-brief.mjs";
import {
  CREATIVE_TASK_TYPES,
  normalizeScriptProfile,
  SCRIPT_PROFILE_FIELDS,
  userSelectedScriptProfileFields
} from "../../../tools/script-profile.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workspaceRoot = path.join(agentRoot, "workspaces");

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new Error(label + "不存在或不是有效 JSON");
  }
}

async function assertReference(workspaceDir, file, label = "附件记录") {
  if (!file || typeof file.reference_path !== "string" || !file.reference_path.startsWith("references/")) {
    throw new Error(label + "缺少 references/ 下的 reference_path");
  }
  const target = path.resolve(workspaceDir, file.reference_path);
  if (!isInside(workspaceDir, target) || !(await fs.stat(target).then((stat) => stat.isFile()).catch(() => false))) {
    throw new Error("归档文件不存在：" + file.reference_path);
  }
  if (file.text_status === "available") {
    if (typeof file.text_path !== "string" || !file.text_path.startsWith("references/")) {
      throw new Error("附件缺少可读文本路径：" + file.reference_path);
    }
    const textPath = path.resolve(workspaceDir, file.text_path);
    const text = await fs.readFile(textPath, "utf8").catch(() => "");
    if (!isInside(workspaceDir, textPath) || !text.trim()) {
      throw new Error("附件提取文本不存在或为空：" + file.text_path);
    }
  }
}

function assertBrief(project) {
  const brief = project.distribution_brief;
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) {
    throw new Error("1.1-user-input.json 缺少发行任务书");
  }
  if (!["complete", "provisional"].includes(brief.status)) {
    throw new Error("发行任务书状态必须为 complete 或 provisional");
  }
  if (!Array.isArray(brief.target_countries) || !Array.isArray(brief.market_deliverables) || !Array.isArray(brief.missing_fields)
    || !Array.isArray(brief.inferred_fields) || !Array.isArray(brief.assumption_notes)) {
    throw new Error("发行任务书字段结构不完整");
  }
  if (typeof brief.target_locale !== "string" || !brief.target_locale.trim()) {
    throw new Error("发行任务书缺少主交付 locale");
  }
  const locale = normalizeLocale(brief.target_locale);
  if (project.target_language !== locale) {
    throw new Error("target_language 必须与发行任务书的主交付 locale 一致");
  }
  if (brief.status === "complete" && brief.missing_fields.length) {
    throw new Error("完整发行任务书不能保留缺失字段");
  }
  return brief;
}

export async function validateProjectWorkspace(workspace) {
  const workspaceDir = path.resolve(workspace);
  if (!isInside(workspaceRoot, workspaceDir)) throw new Error("项目目录必须位于 workspaces/ 下");
  if (!(await fs.stat(workspaceDir).then((stat) => stat.isDirectory()).catch(() => false))) {
    throw new Error("项目目录不存在");
  }
  const userInput = await readJson(path.join(workspaceDir, "1.1-user-input.json"), "1.1-user-input.json");
  const progress = await readJson(path.join(workspaceDir, "1.2-project-progress.json"), "1.2-project-progress.json");
  const project = userInput.project || {};
  if (!project.project_name || !project.target_region || !project.source_script) {
    throw new Error("1.1-user-input.json 缺少项目名称、目标地区或源文件信息");
  }
  if (project.workspace !== path.posix.join("workspaces", path.basename(workspaceDir))) {
    throw new Error("1.1-user-input.json 的 workspace 与实际目录不一致");
  }
  if (!userInput.audit?.created_at || !userInput.audit?.created_by || !userInput.audit?.updated_at || !userInput.audit?.updated_by) {
    throw new Error("1.1-user-input.json 缺少审计信息");
  }
  const brief = assertBrief(project);
  await assertReference(workspaceDir, project.source_script, "源文件记录");
  for (const attachment of project.attachments || []) await assertReference(workspaceDir, attachment);
  const taskType = project.task_type || "rewrite";
  if (CREATIVE_TASK_TYPES.includes(taskType)) {
    normalizeScriptProfile(taskType, brief, {
      defaultAuto: false,
      allowAuto: true,
      userSelectedFields: userSelectedScriptProfileFields(brief)
    });
  } else if (SCRIPT_PROFILE_FIELDS.some((field) => Object.hasOwn(brief, field))) {
    throw new Error("当前任务场景不应包含受众、主题、背景或设定");
  }
  const requiresTranslation = project.requires_translation !== false;
  const expectedSourcePath = taskType === "novel"
    ? "runtime/原始小说.md"
    : taskType === "replicate"
      ? "output/爆款分析报告.md"
      : "output/原始剧本.md";
  if (project.source_script.output_path !== expectedSourcePath) {
    throw new Error(`源内容缺少 ${expectedSourcePath} 输出记录`);
  }
  const originalScript = path.resolve(workspaceDir, project.source_script.output_path);
  const originalScriptText = await fs.readFile(originalScript, "utf8").catch(() => "");
  if (!isInside(workspaceDir, originalScript) || !originalScriptText.trim()) {
    throw new Error(`${expectedSourcePath} 不存在或内容为空`);
  }
  const preferenceMemory = await readJson(path.join(workspaceDir, "memory", "stage-preferences.json"), "memory/stage-preferences.json");
  if (!preferenceMemory || typeof preferenceMemory.preferences !== "object" || Array.isArray(preferenceMemory.preferences)) {
    throw new Error("memory/stage-preferences.json 结构无效");
  }

  const projectInit = progress.stages?.project_init;
  const expectedNextSkill = taskType === "translate"
    ? "dialogue_translate"
    : taskType === "review"
      ? "foreign_review"
      : taskType === "humanize"
        ? "humanizer_zh"
      : taskType === "novel"
        ? "novel_analysis"
        : "world_view";
  const expectedDownstreamPending = taskType === "translate"
    ? progress.stages?.dialogue_translate?.status === "pending"
    : taskType === "review"
      ? progress.stages?.foreign_review?.status === "pending"
      : taskType === "humanize"
        ? progress.stages?.humanizer_zh?.status === "pending"
      : taskType === "novel"
        ? ["novel_analysis", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", ...(requiresTranslation ? ["dialogue_translate"] : []), "foreign_review"]
        .every((stage) => progress.stages?.[stage]?.status === "pending")
      : ["world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", ...(requiresTranslation ? ["dialogue_translate"] : []), "foreign_review"]
        .every((stage) => progress.stages?.[stage]?.status === "pending");
  const expectedTranslationStatus = requiresTranslation || !["rewrite", "novel", "replicate"].includes(taskType)
    ? true
    : progress.stages?.dialogue_translate?.status === "skipped";
  const ready = brief.status === "complete";
  const expectedStatus = ready ? "ready_for_next_skill" : "project_init:needs_revision";
  const expectedStageStatus = ready ? "completed" : "needs_revision";
  const nextSkill = ready ? expectedNextSkill : "";
  if (progress.status !== expectedStatus || progress.current_skill !== "project_init"
    || progress.next_skill !== nextSkill || projectInit?.status !== expectedStageStatus
    || !expectedDownstreamPending || !expectedTranslationStatus) {
    throw new Error(ready
      ? `1.2-project-progress.json 未处于 project_init 完成、${expectedNextSkill} 待执行状态`
      : "1.2-project-progress.json 未处于发行任务书待补齐状态");
  }
  if (!progress.audit?.created_at || !progress.audit?.created_by || !progress.audit?.updated_at || !progress.audit?.updated_by) {
    throw new Error("1.2-project-progress.json 缺少审计信息");
  }
  return {
    attachment_count: 1 + (project.attachments || []).length,
    distribution_brief_status: brief.status,
    missing_fields: brief.missing_fields,
    next_skill: progress.next_skill || "project_init"
  };
}

function parseWorkspace(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") throw new Error("请使用 --workspace <项目目录>");
  return path.resolve(agentRoot, argv[1]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspaceDir = parseWorkspace(process.argv.slice(2));
    const result = await validateProjectWorkspace(workspaceDir);
    const ready = result.distribution_brief_status === "complete";
    process.stdout.write(JSON.stringify({
      ok: true,
      workspace_dir: workspaceDir,
      message: ready ? "初始化文件已通过校验。" : "项目文件已创建，发行任务书仍待补齐。",
      next_action: ready ? `可以执行 ${result.next_skill}。` : "补齐并确认发行任务书后再执行下一步骤。",
      ...result
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      stage: "project_init",
      tool: "validate",
      message: error.message,
      next_action: "修正用户输入或发行任务书后再校验。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
