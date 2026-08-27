import {
  AUTO_ADAPT_TAG,
  normalizeScriptProfile,
  SCRIPT_PROFILE_FIELDS
} from "./script-profile.mjs";

const BCP47_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

export const DEFAULT_TARGET_EPISODE_COUNT = 35;
export const MATURITY_TARGET_VALUES = Object.freeze([
  "全年龄段影片，适合所有人",
  "PG-13 级影片，允许中等暴力、少量裸露、频繁脏话、轻度吸毒镜头",
  "R限制级影片，允许大量血腥暴力、性爱画面、持续粗口、毒品描写",
  "NC-17 ，成人级影片，允许露骨性爱、极端血腥"
]);
export const DEFAULT_MATURITY_TARGET = MATURITY_TARGET_VALUES[1];

export const DISTRIBUTION_BRIEF_FIELDS = Object.freeze([
  "target_countries",
  "target_locale",
  "market_deliverables"
]);

export function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function splitList(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,，]/u);
  return [...new Set(values.map((item) => cleanText(String(item))).filter(Boolean))];
}

export function normalizeLocale(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  if (!BCP47_PATTERN.test(raw)) {
    throw new Error("主交付 locale 无效。请使用 en-US、es-MX、pt-BR 等 BCP 47 值。");
  }
  try {
    return new Intl.Locale(raw).toString();
  } catch {
    throw new Error("主交付 locale 无效。请使用 en-US、es-MX、pt-BR 等 BCP 47 值。");
  }
}

function positiveInteger(value) {
  if (value === undefined || value === null || cleanText(String(value)) === "") return null;
  if (!/^\d+$/u.test(String(value).trim()) || Number(value) < 1) {
    throw new Error("目标集数必须是正整数。");
  }
  return Number(value);
}

export function resolveTargetEpisodeCount(brief) {
  const value = brief?.target_episode_count;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TARGET_EPISODE_COUNT;
}

export function resolveMaturityTarget(brief) {
  const value = cleanText(brief?.maturity_target ?? brief);
  return MATURITY_TARGET_VALUES.includes(value) ? value : DEFAULT_MATURITY_TARGET;
}

function marketDeliverables(countries, locale, localeSource) {
  if (!countries.length || !locale) return [];
  return countries.map((market) => ({
    market,
    locale,
    delivery_mode: "bilingual_script",
    status: "resolved",
    locale_source: localeSource
  }));
}

export function buildDistributionBrief(values = {}) {
  const countries = splitList(values.targetCountry ?? values.targetCountries);
  if (countries.length > 1) {
    throw new Error("一个项目只能对应一个主交付市场与 locale；多市场请创建独立项目。");
  }

  const explicitLocale = normalizeLocale(values.targetLocale);
  const defaultLocale = normalizeLocale(values.defaultLocale);
  const targetLocale = explicitLocale || defaultLocale;
  const inferredFields = [...new Set(
    (Array.isArray(values.inferredFields) ? values.inferredFields : [])
      .filter((field) => SCRIPT_PROFILE_FIELDS.includes(field))
  )];
  const profileValues = {
    theme: values.theme,
    setting: values.setting,
    background: values.background,
    audience: values.audience
  };
  const userSelectedFields = SCRIPT_PROFILE_FIELDS.filter((field) => {
    const selected = splitList(profileValues[field]);
    return selected.length && !selected.includes(AUTO_ADAPT_TAG) && !inferredFields.includes(field);
  });
  const brief = {
    status: "provisional",
    target_countries: countries,
    target_locale: targetLocale,
    market_deliverables: marketDeliverables(
      countries,
      targetLocale,
      "region_rules:default_locale"
    ),
    locale_contract_status: countries.length && targetLocale ? "single_locale" : targetLocale ? "region_default" : "locale_required",
    requires_separate_language_versions: false,
    missing_fields: [],
    assumptions_require_approval: false,
    inferred_fields: inferredFields,
    assumption_notes: []
  };

  const optionalFields = {
    episode_duration: cleanText(values.episodeDuration),
    target_episode_count: positiveInteger(values.targetEpisodeCount),
    maturity_target: resolveMaturityTarget(values.maturityTarget)
  };
  for (const [field, value] of Object.entries(optionalFields)) {
    if (value !== "" && value !== null) brief[field] = value;
  }
  Object.assign(brief, normalizeScriptProfile(values.taskType || "rewrite", profileValues, {
    userSelectedFields
  }));

  const missing = DISTRIBUTION_BRIEF_FIELDS.filter((field) => {
    const value = brief[field];
    return Array.isArray(value) ? value.length === 0 : value === null || value === "";
  });
  brief.missing_fields = missing;
  if (!missing.length) brief.status = "complete";
  return brief;
}

export function assertDistributionBriefComplete(project) {
  const brief = project?.distribution_brief;
  if (!brief || brief.status !== "complete") {
    const missing = Array.isArray(brief?.missing_fields) && brief.missing_fields.length
      ? "：" + brief.missing_fields.join("、")
      : "";
    throw new Error("发行任务书尚未完成" + missing + "。请先补齐并确认后再进入创作阶段。");
  }
  const locale = normalizeLocale(brief.target_locale);
  if (!locale) throw new Error("发行任务书缺少主交付 locale。");
  return { ...brief, target_locale: locale };
}
