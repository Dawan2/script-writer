#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanText, normalizeLocale } from "./distribution-brief.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.join(agentRoot, "workspaces");
const rulesPath = path.join(agentRoot, ".claude", "config", "region-rules.json");

function normalizeKey(value) {
  return cleanText(value).normalize("NFKC").replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error("无法识别参数：" + key);
    const name = key.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || args[name] !== undefined) {
      throw new Error("参数 --" + name + " 无效或重复");
    }
    args[name] = value;
    index += 1;
  }
  if (Boolean(args.workspace) === Boolean(args["target-region"])) {
    throw new Error("请使用 --workspace <项目目录> 或 --target-region <地区> 其中之一。");
  }
  return args;
}

export async function resolveRegionRules(targetRegion, stage = "") {
  const data = JSON.parse(await fs.readFile(rulesPath, "utf8"));
  const entries = Object.entries(data.regions || {});
  const requested = normalizeKey(targetRegion);
  const matched = entries.find(([key, value]) => [key, ...(value.aliases || [])]
    .some((candidate) => normalizeKey(candidate) === requested));
  if (!matched) {
    throw new Error("未配置目标地区：" + cleanText(targetRegion) + "。可选：" + entries.map(([key]) => key).join("、"));
  }
  const [key, definition] = matched;
  const defaultMarket = cleanText(definition.default_market);
  const defaultLocale = normalizeLocale(definition.default_locale);
  const translationContext = Array.isArray(definition.translation_context)
    ? definition.translation_context.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const stageRules = definition.stage_overrides?.[cleanText(stage)]?.rules;
  const resolvedRules = Array.isArray(stageRules) ? stageRules : definition.rules;
  if (!defaultMarket || !Array.isArray(resolvedRules) || !resolvedRules.every((rule) => cleanText(rule))) {
    throw new Error("地区规则配置无效：" + key);
  }
  if (Array.isArray(definition.translation_context) && translationContext.length !== definition.translation_context.length) {
    throw new Error("地区翻译语境配置无效：" + key);
  }
  return {
    key,
    default_market: defaultMarket,
    default_locale: defaultLocale,
    rules: resolvedRules,
    translation_context: translationContext,
    requires_translation: definition.requires_translation !== false
  };
}

export async function getRegionRules(options) {
  let targetRegion = options["target-region"];
  let targetCountry = cleanText(options["target-country"]);
  let targetLocale = cleanText(options["target-locale"]);
  if (options.workspace) {
    const workspaceDir = path.resolve(agentRoot, options.workspace);
    if (!isInside(workspaceRoot, workspaceDir)) throw new Error("项目目录必须位于 workspaces/ 下。");
    const input = JSON.parse(await fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8"));
    const project = input.project || {};
    targetRegion = project.target_region;
    targetCountry = cleanText(project.distribution_brief?.target_countries?.[0]);
    targetLocale = cleanText(project.distribution_brief?.target_locale || project.target_language);
  }
  const region = await resolveRegionRules(targetRegion, options.stage);
  const result = {
    target_region: region.key,
    target_country: targetCountry || region.default_market,
    target_locale: normalizeLocale(targetLocale || region.default_locale),
    rules: region.rules,
    requires_translation: region.requires_translation
  };
  if (cleanText(options.stage) === "dialogue_translate") {
    result.translation_context = region.translation_context;
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await getRegionRules(args);
    process.stdout.write(JSON.stringify({
      ok: true,
      message: "已获取目标地区规则。",
      next_action: "按照 Skill 的工作流程，继续下一个步骤。",
      ...result
    }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      tool: "get-region-rules",
      message: error.message,
      next_action: "补充或修正目标地区、具体市场和主交付 locale 后重试。"
    }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
