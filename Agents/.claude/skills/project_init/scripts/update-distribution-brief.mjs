#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDistributionBrief } from "../../../tools/distribution-brief.mjs";
import { resolveRegionRules } from "../../../tools/get-region-rules.mjs";
import { hasCompletedFullScript } from "../../../tools/script-artifacts.mjs";
import { SCRIPT_PROFILE_FIELDS } from "../../../tools/script-profile.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const workspaceRoot = path.join(agentRoot, "workspaces");
const REWRITE_STAGES = ["world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review"];
const NOVEL_STAGES = ["novel_analysis", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review"];
const REPLICATE_STAGES = ["world_view", "outline_rewrite", "character_rewrite", "trial_generate", "full_generate", "dialogue_translate", "foreign_review"];

function taskStages(taskType, requiresTranslation) {
  if (taskType === "humanize") return ["humanizer_zh"];
  if (taskType === "translate") return ["dialogue_translate"];
  if (taskType === "review") return ["foreign_review"];
  const stages = taskType === "novel" ? NOVEL_STAGES : taskType === "replicate" ? REPLICATE_STAGES : REWRITE_STAGES;
  return requiresTranslation ? stages : stages.filter((stage) => stage !== "dialogue_translate");
}

function nextSkillForTaskType(taskType) {
  if (taskType === "translate") return "dialogue_translate";
  if (taskType === "review") return "foreign_review";
  if (taskType === "humanize") return "humanizer_zh";
  if (taskType === "novel") return "novel_analysis";
  return "world_view";
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--confirm") {
      if (args.confirm) throw new Error("参数 --confirm 不能重复");
      args.confirm = true;
      continue;
    }
    if (!key.startsWith("--")) throw new Error("无法识别参数：" + key);
    const name = key.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || args[name] !== undefined) {
      throw new Error("参数 --" + name + " 无效或重复");
    }
    args[name] = value;
    index += 1;
  }
  for (const required of ["workspace", "updated-by"]) {
    if (!args[required]) throw new Error("缺少 --" + required + " 参数");
  }
  return args;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function valueOr(args, name, fallback) {
  return Object.hasOwn(args, name) ? args[name] : fallback;
}

export async function updateDistributionBrief(args) {
  const workspaceDir = path.resolve(agentRoot, args.workspace);
  if (!isInside(workspaceRoot, workspaceDir)) throw new Error("项目目录必须位于 workspaces/ 下。");
  const inputPath = path.join(workspaceDir, "1.1-user-input.json");
  const progressPath = path.join(workspaceDir, "1.2-project-progress.json");
  const [input, progress] = await Promise.all([
    fs.readFile(inputPath, "utf8").then(JSON.parse),
    fs.readFile(progressPath, "utf8").then(JSON.parse)
  ]);
  const project = input.project || {};
  const existing = project.distribution_brief || {};
  const region = await resolveRegionRules(project.target_region);
  const profileArgNames = {
    theme: "theme",
    setting: "setting",
    background: "background",
    audience: "audience"
  };
  const inferredFields = (Array.isArray(existing.inferred_fields) ? existing.inferred_fields : [])
    .filter((field) => SCRIPT_PROFILE_FIELDS.includes(field) && !Object.hasOwn(args, profileArgNames[field]));
  const brief = buildDistributionBrief({
    targetCountry: region.default_market,
    targetLocale: region.default_locale,
    episodeDuration: valueOr(args, "episode-duration", existing.episode_duration),
    targetEpisodeCount: valueOr(args, "target-episode-count", existing.target_episode_count),
    maturityTarget: valueOr(args, "maturity-target", existing.maturity_target),
    theme: valueOr(args, "theme", existing.theme),
    setting: valueOr(args, "setting", existing.setting),
    background: valueOr(args, "background", existing.background),
    audience: valueOr(args, "audience", existing.audience),
    inferredFields,
    taskType: project.task_type,
    defaultLocale: region.default_locale
  });
  const changed = JSON.stringify(existing) !== JSON.stringify(brief);
  const actor = args["updated-by"];
  const now = new Date().toISOString();
  project.distribution_brief = brief;
  project.target_language = brief.target_locale;
  project.requires_translation = region.requires_translation;
  input.project = project;
  input.status = brief.status === "complete" ? "project_init:completed" : "project_init:needs_revision";
  input.audit = { ...input.audit, updated_at: now, updated_by: actor };

  const invalidatedStages = [];
  if (changed) {
    taskStages(project.task_type, region.requires_translation).forEach((stage) => {
      const previous = progress.stages?.[stage] || {};
      if (previous.status !== "pending") invalidatedStages.push(stage);
      progress.stages = { ...(progress.stages || {}) };
      progress.stages[stage] = {
        ...previous,
        status: "pending",
        ...(stage === "full_generate" && hasCompletedFullScript(project, previous)
          ? { completed_once: true }
          : {}),
        invalidated_by: "project_init",
        updated_at: now,
        updated_by: actor
      };
    });
  }
  if (project.requires_translation === false) {
    progress.stages = { ...(progress.stages || {}) };
    progress.stages.dialogue_translate = {
      ...(progress.stages.dialogue_translate || {}),
      status: "skipped",
      updated_at: now,
      updated_by: actor
    };
  }
  const ready = brief.status === "complete";
  const initPrevious = progress.stages?.project_init || {};
  progress.stages = { ...(progress.stages || {}) };
  progress.stages.project_init = {
    ...initPrevious,
    status: ready ? "completed" : "needs_revision",
    updated_at: now,
    updated_by: actor
  };
  progress.status = ready ? "ready_for_next_skill" : "project_init:needs_revision";
  progress.current_skill = "project_init";
  progress.next_skill = ready ? nextSkillForTaskType(project.task_type) : "";
  progress.audit = { ...progress.audit, updated_at: now, updated_by: actor };
  await Promise.all([writeJson(inputPath, input), writeJson(progressPath, progress)]);
  return {
    workspace_dir: workspaceDir,
    distribution_brief_status: brief.status,
    missing_fields: brief.missing_fields,
    invalidated_stages: invalidatedStages,
    next_skill: progress.next_skill
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await updateDistributionBrief(args);
    const ready = result.distribution_brief_status === "complete";
    process.stdout.write(JSON.stringify({
      ok: true,
      message: ready ? "发行配置已更新。" : "发行配置缺少地区派生信息。",
      next_action: ready ? `可以执行 ${result.next_skill}。` : "检查目标地区后重试。",
      ...result
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      stage: "project_init",
      tool: "update-distribution-brief",
      message: error.message,
      next_action: "检查发行字段和主交付 locale 后重试。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
