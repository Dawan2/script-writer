import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const taxonomyPath = path.resolve(toolDir, "../config/script-tag-taxonomy.json");

export const AUTO_ADAPT_TAG = "自动适配";
export const CREATIVE_TASK_TYPES = Object.freeze(["rewrite", "novel", "replicate"]);
export const SCRIPT_PROFILE_FIELDS = Object.freeze(["theme", "setting", "background", "audience"]);
export const SCRIPT_PROFILE_LABELS = Object.freeze({
  theme: "主题",
  setting: "设定",
  background: "背景",
  audience: "受众"
});
export const SCRIPT_PROFILE_LIMITS = Object.freeze({
  theme: 4,
  setting: 4,
  background: 4,
  audience: 1
});
export const SCRIPT_TAG_TAXONOMY = Object.freeze(JSON.parse(fs.readFileSync(taxonomyPath, "utf8")));

const BACKGROUND_ERA_TAGS = new Set(["现代", "古代", "年代", "民国"]);

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function splitList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,，]/u);
  return [...new Set(values.map((item) => cleanText(String(item))).filter(Boolean))];
}

function profileValues(value) {
  return splitList(value);
}

export function scriptProfileErrors(profile, { allowAuto = true, userSelectedFields = [] } = {}) {
  const errors = [];
  const normalized = {};
  const selectedFields = new Set(userSelectedFields.filter((field) => SCRIPT_PROFILE_FIELDS.includes(field)));
  SCRIPT_PROFILE_FIELDS.forEach((kind) => {
    const values = profileValues(profile?.[kind]);
    normalized[kind] = values;
    const label = SCRIPT_PROFILE_LABELS[kind];
    if (!values.length) {
      errors.push(`${label}不能为空`);
      return;
    }
    if (values.includes(AUTO_ADAPT_TAG)) {
      if (!allowAuto) errors.push(`${label}仍为自动适配`);
      if (values.length > 1) errors.push(`${label}选择自动适配时不能同时选择其他标签`);
      return;
    }
    const invalid = values.filter((value) => !SCRIPT_TAG_TAXONOMY[kind].includes(value));
    if (invalid.length) errors.push(`${label}标签不在受控词表中：${invalid.join("、")}`);
    if (values.length > SCRIPT_PROFILE_LIMITS[kind]) {
      errors.push(`${label}最多选择 ${SCRIPT_PROFILE_LIMITS[kind]} 项`);
    }
  });

  const eras = normalized.background.filter((value) => BACKGROUND_ERA_TAGS.has(value));
  if (eras.length > 1 && !selectedFields.has("background")) {
    errors.push(`背景不能同时标注${eras.join("、")}，应以主要剧情时空为准`);
  }
  const themes = new Set(normalized.theme);
  const backgrounds = new Set(normalized.background);
  if (!(selectedFields.has("theme") && selectedFields.has("background"))) {
    if (themes.has("现代言情") && ["古代", "宫廷", "年代", "民国"].some((value) => backgrounds.has(value))) {
      errors.push("现代言情与古代、宫廷、年代或民国主背景不一致");
    }
    if (themes.has("古风言情") && ["现代", "都市", "职场", "校园"].some((value) => backgrounds.has(value))) {
      errors.push("古风言情与现代、都市、职场或校园主背景不一致");
    }
    if (themes.has("年代爱情") && ["现代", "古代", "民国"].some((value) => backgrounds.has(value))) {
      errors.push("年代爱情与当前主背景不一致");
    }
    if (themes.has("民国爱情") && ["现代", "古代", "年代"].some((value) => backgrounds.has(value))) {
      errors.push("民国爱情与当前主背景不一致");
    }
  }
  return [...new Set(errors)];
}

export function normalizeScriptProfile(
  taskType,
  values = {},
  { defaultAuto = true, allowAuto = true, userSelectedFields = [] } = {}
) {
  if (!CREATIVE_TASK_TYPES.includes(cleanText(taskType))) return {};
  const profile = Object.fromEntries(SCRIPT_PROFILE_FIELDS.map((kind) => {
    const selected = profileValues(values[kind]);
    return [kind, selected.length ? selected : defaultAuto ? [AUTO_ADAPT_TAG] : []];
  }));
  const errors = scriptProfileErrors(profile, { allowAuto, userSelectedFields });
  if (errors.length) throw new Error(errors.join("；"));
  return profile;
}

export function pendingScriptProfileFields(brief) {
  return SCRIPT_PROFILE_FIELDS.filter((kind) => {
    const values = profileValues(brief?.[kind]);
    return !values.length || values.includes(AUTO_ADAPT_TAG);
  });
}

export function userSelectedScriptProfileFields(brief) {
  const inferredFields = new Set(Array.isArray(brief?.inferred_fields) ? brief.inferred_fields : []);
  return SCRIPT_PROFILE_FIELDS.filter((kind) => {
    const values = profileValues(brief?.[kind]);
    return values.length && !values.includes(AUTO_ADAPT_TAG) && !inferredFields.has(kind);
  });
}

export function assertScriptProfileResolved(project, expectedStage) {
  const taskType = cleanText(project?.task_type);
  const requiredStage = taskType === "novel" ? "novel_analysis" : "world_view";
  if (!CREATIVE_TASK_TYPES.includes(taskType) || requiredStage !== expectedStage) return {};
  const profile = Object.fromEntries(SCRIPT_PROFILE_FIELDS.map((kind) => [kind, profileValues(project?.distribution_brief?.[kind])]));
  const errors = scriptProfileErrors(profile, {
    allowAuto: false,
    userSelectedFields: userSelectedScriptProfileFields(project?.distribution_brief)
  });
  if (errors.length) throw new Error(`剧本设定尚未完成：${errors.join("；")}`);
  return profile;
}
