#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanText, normalizeLocale } from "./distribution-brief.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.join(agentRoot, "workspaces");

const TASK_TYPE_LABELS = Object.freeze({
  rewrite: "剧本改写",
  novel: "小说改编",
  replicate: "爆款复刻",
  review: "剧本审核",
  translate: "台词翻译",
  humanize: "剧本润色"
});

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") {
    throw new Error("请使用 --workspace <项目目录>");
  }
  return argv[1];
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(value) {
  const raw = cleanText(value).replace(/\\/gu, "/");
  if (!raw || path.posix.isAbsolute(raw)) return "";
  const normalized = path.posix.normalize(raw);
  return normalized === "." || normalized === ".." || normalized.startsWith("../") ? "" : normalized;
}

function positiveInteger(value) {
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim()) && Number(value) > 0) {
    return Number(value);
  }
  return null;
}

function uniqueTexts(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => cleanText(item)).filter(Boolean))];
}

function localeLabel(value) {
  const raw = cleanText(value);
  if (!raw) return "";

  let locale;
  try {
    locale = new Intl.Locale(normalizeLocale(raw));
  } catch {
    return raw;
  }

  const language = new Intl.DisplayNames(["zh-Hans"], { type: "language" }).of(locale.language) || locale.language;
  const region = locale.region
    ? new Intl.DisplayNames(["zh-Hans"], { type: "region" }).of(locale.region) || locale.region
    : "";
  return region ? `${language}（${region}，${locale.toString()}）` : `${language}（${locale.toString()}）`;
}

function sourceMaterialType(taskType) {
  if (taskType === "novel") return "原始小说";
  if (taskType === "replicate") return "爆款分析报告";
  if (taskType === "review") return "待审剧本";
  if (taskType === "translate") return "待翻译剧本";
  if (taskType === "humanize") return "待润色剧本";
  return "原始剧本";
}

function readableAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  const seen = new Set();
  return attachments.flatMap((attachment) => {
    if (!isObject(attachment) || attachment.text_status !== "available") return [];
    const name = cleanText(attachment.original_name);
    const textPath = safeRelativePath(attachment.text_path);
    if (!name || !textPath || seen.has(textPath)) return [];
    seen.add(textPath);
    return [{ "名称": name, "内容文件": textPath }];
  });
}

export function summarizeUserRequirements(userInput) {
  const project = userInput?.project;
  if (!isObject(project)) throw new Error("1.1-user-input.json 缺少项目资料");

  const taskType = cleanText(project.task_type);
  const brief = isObject(project.distribution_brief) ? project.distribution_brief : {};
  const requirements = {};
  const taskLabel = TASK_TYPE_LABELS[taskType] || taskType;
  const projectName = cleanText(project.project_name);
  const region = cleanText(project.target_region);
  const markets = uniqueTexts(brief.target_countries);
  const locale = cleanText(brief.target_locale || project.target_language);
  const duration = cleanText(brief.episode_duration);
  const episodeCount = positiveInteger(brief.target_episode_count);
  const maturityTarget = cleanText(brief.maturity_target);
  const source = isObject(project.source_script) ? project.source_script : {};
  const sourceName = cleanText(source.display_name);
  const sourcePath = safeRelativePath(source.output_path);
  const extraRequirements = cleanText(project.extra_requirements);
  const attachments = readableAttachments(project.attachments);

  if (taskLabel) requirements["任务场景"] = taskLabel;
  if (projectName) requirements["项目名称"] = projectName;
  if (region) requirements["目标发行地区"] = region;
  if (markets.length) requirements["目标市场"] = markets;
  if (locale) requirements["主要交付语言"] = localeLabel(locale);
  if (typeof project.requires_translation === "boolean") {
    requirements["交付要求"] = project.requires_translation
      ? "生成中文剧本及目标语台词译稿"
      : "仅生成中文剧本，不生成台词译稿";
  }
  if (duration) requirements["单集时长"] = duration;
  if (episodeCount) requirements["目标集数"] = episodeCount;
  if (maturityTarget) requirements["内容分级"] = maturityTarget;
  const scriptProfileFields = [
    ["audience", "受众"],
    ["theme", "主题"],
    ["background", "背景"],
    ["setting", "设定"]
  ];
  scriptProfileFields.forEach(([field, label]) => {
    const values = uniqueTexts(brief[field]);
    if (values.length) requirements[label] = values;
  });
  if (sourceName || sourcePath) {
    const material = { "材料类型": sourceMaterialType(taskType) };
    if (sourceName) material["名称"] = sourceName;
    if (sourcePath) material["内容文件"] = sourcePath;
    requirements["原始材料"] = material;
  }
  if (extraRequirements) requirements["用户额外要求"] = extraRequirements;
  if (attachments.length) requirements["可读附件"] = attachments;

  return { "用户需求": requirements };
}

function resolveWorkspace(workspace) {
  const workspaceDir = path.resolve(agentRoot, workspace);
  if (!isInside(workspaceRoot, workspaceDir)) throw new Error("项目目录必须位于 workspaces/ 下");
  return workspaceDir;
}

export async function getUserRequirements(workspace) {
  const workspaceDir = resolveWorkspace(workspace);
  let userInput;
  try {
    userInput = JSON.parse(await fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8"));
  } catch {
    throw new Error("1.1-user-input.json 不存在或不是有效 JSON");
  }
  return summarizeUserRequirements(userInput);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await getUserRequirements(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({
      ok: true,
      message: "已整理当前项目的有效用户需求。",
      next_action: "按照 Skill 的工作流程，继续下一个步骤。",
      ...result
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      tool: "get-user-requirements",
      message: error.message,
      next_action: "检查项目目录和项目输入后重试。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
