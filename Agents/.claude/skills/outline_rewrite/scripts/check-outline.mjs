#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateProgress } from "../../../tools/update-progress.mjs";
import {
  englishScriptTitle,
  englishScriptTitleIssue,
  outlineDocumentHeading,
  outlineDocumentRelativePath,
  retainedProjectTitleIssue,
  rewrittenTitleIssue,
  scriptTitle,
  shouldRenameScriptTitle,
  shouldIncludeEnglishScriptTitle
} from "../../../tools/script-artifacts.mjs";
import { resolveTargetEpisodeCount } from "../../../tools/distribution-brief.mjs";
import { deriveNovelOutlinePlan } from "../../novel_analysis/scripts/novel-analysis-utils.mjs";
import { ROLE_NAME_MAPPING_KEY } from "./role-name-map.mjs";
import {
  loadStageExecutionStrategy,
  shouldValidateStageExecution,
  stageExecutionSpecIssues,
  stageExecutionStrategyIssues
} from "../../_shared/scripts/stage-execution-spec.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../references/outline.json5");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--workspace" || argv[2] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --updated-by <用户>");
  }
  return { workspace: path.resolve(agentRoot, argv[1]), updatedBy: argv[3] || "admin" };
}

function parseTemplate(text) {
  return JSON.parse(text.replace(/\/\/.*$/gmu, ""));
}

function hasExactKeys(value, expectedKeys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function hasKeysWithOptional(value, expectedKeys, optionalKeys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...expectedKeys, ...optionalKeys]);
  return expectedKeys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function requireText(value, label, issues) {
  if (typeof value !== "string" || !value.trim()) issues.push(`${label}必须是非空字符串`);
}

function validateNovelSourceUnits(value, label, knownIds, issues) {
  if (!Array.isArray(value) || !value.length) {
    issues.push(`${label}至少需要关联一个原著剧情单元`);
    return;
  }
  value.forEach((unitId, index) => {
    if (typeof unitId !== "string" || !knownIds.has(unitId.trim())) {
      issues.push(`${label}的原著剧情单元第 ${index + 1} 项无效`);
    }
  });
}

function normalizedNovelSourceUnitIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((unitId) => typeof unitId === "string")
    .map((unitId) => unitId.trim())
    .filter(Boolean))];
}

function novelSourceGroups(opening, units) {
  const groups = [];
  if (opening && typeof opening === "object" && !Array.isArray(opening)) {
    groups.push({
      label: "开篇",
      unitIds: new Set(normalizedNovelSourceUnitIds(opening["原著剧情单元"]))
    });
  }
  if (Array.isArray(units)) {
    units.forEach((unit, index) => {
      if (!unit || typeof unit !== "object" || Array.isArray(unit)) return;
      groups.push({
        label: `第 ${index + 1} 个剧情单元`,
        unitIds: new Set(normalizedNovelSourceUnitIds(unit["原著剧情单元"]))
      });
    });
  }
  return groups;
}

function validateNovelDecisionMapping(novelAnalysis, opening, outlineUnits, issues) {
  const sourceUnits = Array.isArray(novelAnalysis?.["剧情单元"])
    ? novelAnalysis["剧情单元"].filter((unit) => unit && typeof unit === "object" && !Array.isArray(unit))
    : [];
  const sourceUnitsById = new Map(sourceUnits.map((unit) => [typeof unit["单元ID"] === "string" ? unit["单元ID"].trim() : "", unit]));
  const groups = novelSourceGroups(opening, outlineUnits);
  const referencedUnitIds = new Set(groups.flatMap((group) => [...group.unitIds]));

  sourceUnits.forEach((sourceUnit) => {
    const sourceUnitId = typeof sourceUnit["单元ID"] === "string" ? sourceUnit["单元ID"].trim() : "";
    if (!sourceUnitId) return;
    if (!referencedUnitIds.has(sourceUnitId)) {
      issues.push(`原著剧情单元 ${sourceUnitId} 必须至少关联到一个故事梗概单元`);
      return;
    }
    if (sourceUnit["已确认合并"] !== true) return;

    const targetUnitId = typeof sourceUnit["合并目标单元ID"] === "string"
      ? sourceUnit["合并目标单元ID"].trim()
      : "";
    if (!targetUnitId) {
      issues.push(`已确认合并的原著剧情单元 ${sourceUnitId} 缺少合并目标单元ID`);
      return;
    }
    const targetUnit = sourceUnitsById.get(targetUnitId);
    if (!targetUnit) {
      issues.push(`已确认合并的原著剧情单元 ${sourceUnitId} 的目标 ${targetUnitId} 不存在`);
      return;
    }
    if (targetUnit["已确认合并"] === true) {
      issues.push(`已确认合并的原著剧情单元 ${sourceUnitId} 不能并入另一已确认合并的单元 ${targetUnitId}`);
      return;
    }
    if (!groups.some((group) => group.unitIds.has(sourceUnitId) && group.unitIds.has(targetUnitId))) {
      issues.push(`已确认合并的原著剧情单元 ${sourceUnitId} 必须与其目标 ${targetUnitId} 关联到同一个故事梗概单元`);
    }
  });
}

function validateNovelOutlineCapacity(opening, units, adaptationPlan, issues) {
  const outlineUnits = Array.isArray(units) ? units : [];
  const budgets = Array.isArray(adaptationPlan?.outline_unit_budgets) ? adaptationPlan.outline_unit_budgets : [];
  if (outlineUnits.length > budgets.length) {
    issues.push(`故事梗概最多可安排 ${budgets.length} 个剧情单元，当前为 ${outlineUnits.length} 个`);
  }
  const openingEpisodeCount = Array.isArray(opening?.["剧集"]) ? opening["剧集"].length : 0;
  outlineUnits.forEach((unit, index) => {
    const budget = budgets[index];
    if (!budget) return;
    const unitEpisodeCount = Array.isArray(unit?.["剧集"]) ? unit["剧集"].length : 0;
    const actualEpisodeCount = index === 0 ? openingEpisodeCount + unitEpisodeCount : unitEpisodeCount;
    if (actualEpisodeCount <= budget.max_episodes) return;
    const label = index === 0 ? "第 1 个剧情单元（含开篇第 1 集）" : `第 ${index + 1} 个剧情单元`;
    issues.push(`${label}最多 ${budget.max_episodes} 集，当前为 ${actualEpisodeCount} 集`);
  });
}

function checkNames(value, label, issues, localizedNames = null) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${label}至少需要一名角色`);
    return;
  }
  value.forEach((name, index) => {
    const itemLabel = `${label}第 ${index + 1} 项`;
    requireText(name, itemLabel, issues);
    const normalized = typeof name === "string" ? name.trim() : "";
    if (localizedNames && normalized && !localizedNames.has(normalized)) {
      issues.push(`${itemLabel}必须使用${ROLE_NAME_MAPPING_KEY}中的中文名称`);
    }
  });
}

function checkEpisode(episode, label, expectedEpisode, episodeKeys, ideaKeys, issues, localizedNames) {
  if (!hasExactKeys(episode, episodeKeys)) {
    issues.push(`${label}字段必须与 outline.json5 一致`);
    return;
  }
  if (!Number.isInteger(episode["集数"]) || episode["集数"] !== expectedEpisode) {
    issues.push(`${label}的集数必须为连续编号 ${expectedEpisode}`);
  }
  requireText(episode["剧集名称"], `${label}的剧集名称`, issues);
  checkNames(episode["关键角色"], `${label}的关键角色`, issues, localizedNames);
  const idea = episode["写作思路"];
  if (!hasExactKeys(idea, ideaKeys)) {
    issues.push(`${label}的写作思路字段必须与 outline.json5 一致`);
  } else {
    requireText(idea["开场冲突"], `${label}的开场冲突`, issues);
    if (!Array.isArray(idea["主要转折"]) || idea["主要转折"].length === 0) {
      issues.push(`${label}的主要转折至少需要一项`);
    } else {
      idea["主要转折"].forEach((turn, turnIndex) => requireText(turn, `${label}的主要转折第 ${turnIndex + 1} 项`, issues));
    }
    requireText(idea["结尾承接"], `${label}的结尾承接`, issues);
  }
  requireText(episode["剧集梗概"], `${label}的剧集梗概`, issues);
}

function outlineEpisodeCount(opening, units) {
  const openingCount = Array.isArray(opening?.["剧集"]) ? opening["剧集"].length : 0;
  const unitCount = Array.isArray(units)
    ? units.reduce((count, unit) => count + (Array.isArray(unit?.["剧集"]) ? unit["剧集"].length : 0), 0)
    : 0;
  return openingCount + unitCount;
}

function hasHan(value) {
  return /\p{Script=Han}/u.test(value);
}

function hasLatin(value) {
  return /\p{Script=Latin}/u.test(value);
}

function validateRoleNameMappings(outline, template, issues, { requiresTranslation }) {
  const mappings = outline[ROLE_NAME_MAPPING_KEY];
  const mappingTemplate = template[ROLE_NAME_MAPPING_KEY]?.[0];
  const mappingKeys = mappingTemplate && typeof mappingTemplate === "object" ? Object.keys(mappingTemplate) : [];
  if (!mappingKeys.length) throw new Error("outline.json5 缺少关键角色名称映射模板");
  if (!Array.isArray(mappings) || !mappings.length) {
    issues.push(`${ROLE_NAME_MAPPING_KEY}至少需要一项`);
    return { localizedNames: null };
  }

  const englishNames = new Set();
  const localizedNames = new Set();
  mappings.forEach((mapping, index) => {
    const label = `${ROLE_NAME_MAPPING_KEY}第 ${index + 1} 项`;
    if (!hasExactKeys(mapping, mappingKeys)) {
      issues.push(`${label}字段必须与 outline.json5 一致`);
      return;
    }
    ["英文名称", "中文名称"].forEach((field) => requireText(mapping[field], `${label}的${field}`, issues));
    const englishName = typeof mapping["英文名称"] === "string" ? mapping["英文名称"].trim() : "";
    const localizedName = typeof mapping["中文名称"] === "string" ? mapping["中文名称"].trim() : "";
    if (!englishName || !localizedName) return;
    if (requiresTranslation) {
      if (!hasLatin(englishName) || hasHan(englishName)) {
        issues.push(`${label}的英文名称必须使用拉丁字母名称`);
      }
      if (!hasHan(localizedName)) {
        issues.push(`${label}的中文名称必须是英文名称的中文音译显示名`);
      }
    } else if (englishName !== localizedName || !hasHan(localizedName)) {
      issues.push(`${label}不需要翻译时，英文名称和中文名称都必须保留原著中文名`);
    }
    if (englishNames.has(englishName.toLocaleLowerCase("en-US"))) issues.push(`${label}的英文名称“${englishName}”重复`);
    if (localizedNames.has(localizedName)) issues.push(`${label}的中文名称“${localizedName}”重复`);
    englishNames.add(englishName.toLocaleLowerCase("en-US"));
    localizedNames.add(localizedName);
  });
  return { localizedNames };
}

function renderRoleNameList(mappings, { requiresTranslation }) {
  return [
    "## 关键角色名称",
    "",
    ...mappings.map((mapping) => {
      const localizedName = String(mapping["中文名称"] ?? "").trim();
      const englishName = String(mapping["英文名称"] ?? "").trim();
      return requiresTranslation && englishName && englishName !== localizedName
        ? `- ${localizedName}（${englishName}）`
        : `- ${localizedName}`;
    }),
    ""
  ];
}

function renderOutline(outline, { requiresTranslation }) {
  const opening = outline["开篇"];
  const firstEpisode = opening["剧集"][0];
  const lines = [
    "# 剧本大纲",
    "",
    ...renderRoleNameList(outline[ROLE_NAME_MAPPING_KEY], { requiresTranslation }),
    "## 故事梗概",
    "",
    outline["故事梗概"],
    "",
    "## 开篇",
    "",
    opening["开篇描述"],
    "",
    `关键角色：${opening["关键角色"].join("、")}`,
    "",
    `### 第${firstEpisode["集数"]}集：${firstEpisode["剧集名称"]}`,
    "",
    `关键角色：${firstEpisode["关键角色"].join("、")}`,
    "",
    firstEpisode["剧集梗概"],
    "",
    "## 剧情单元"
  ];
  outline["剧情单元"].forEach((unit, index) => {
    lines.push("", `### 单元${index + 1}：${unit["单元名称"]}`, "", unit["单元描述"], "", `关键角色：${unit["关键角色"].join("、")}`);
    unit["剧集"].forEach((episode) => {
      lines.push("", `#### 第${episode["集数"]}集：${episode["剧集名称"]}`, "", `关键角色：${episode["关键角色"].join("、")}`, "", episode["剧集梗概"]);
    });
  });
  lines[0] = outlineDocumentHeading(outline);
  return `${lines.join("\n")}\n`;
}

export async function checkOutline(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [template, raw] = await Promise.all([
    fs.readFile(templatePath, "utf8").then(parseTemplate),
    fs.readFile(path.join(workspaceDir, "3.1-outline.json"), "utf8")
  ]);
  const userInput = await fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse);
  const outline = JSON.parse(raw);
  if (!outline || typeof outline !== "object" || Array.isArray(outline)) {
    return { ok: false, issues: ["3.1-outline.json 顶层必须是对象"] };
  }
  const issues = [];
  const validateExecution = await shouldValidateStageExecution(workspaceDir, "outline_rewrite");
  if (validateExecution) {
    issues.push(...await stageExecutionSpecIssues(workspaceDir, "outline_rewrite", userInput));
    issues.push(...await stageExecutionStrategyIssues(workspaceDir, "outline_rewrite", userInput));
  }
  const novelTask = userInput.project?.task_type === "novel";
  const renameTitle = shouldRenameScriptTitle(userInput.project);
  const requiresTranslation = userInput.project?.requires_translation !== false;
  const requiresEnglishTitle = shouldIncludeEnglishScriptTitle(userInput.project);
  const novelAnalysis = novelTask
    ? await fs.readFile(path.join(workspaceDir, "2.1-novel-analysis.json"), "utf8").then(JSON.parse).catch(() => null)
    : null;
  const adaptationPlan = novelTask ? deriveNovelOutlinePlan(userInput.project) : null;
  const novelUnitIds = new Set(Array.isArray(novelAnalysis?.["剧情单元"])
    ? novelAnalysis["剧情单元"].map((unit) => unit?.["单元ID"]).filter((value) => typeof value === "string")
    : []);
  const targetEpisodeCount = resolveTargetEpisodeCount(userInput.project?.distribution_brief);
  const topLevelKeys = Object.keys(template);
  const openingTemplate = template["开篇"] || {};
  const openingKeys = Object.keys(openingTemplate);
  const unitTemplate = template["剧情单元"]?.[0] || {};
  const unitKeys = Object.keys(unitTemplate);
  const episodeTemplate = unitTemplate["剧集"]?.[0] || {};
  const episodeKeys = Object.keys(episodeTemplate);
  const ideaTemplate = episodeTemplate["写作思路"] || {};
  const ideaKeys = Object.keys(ideaTemplate);

  if (novelTask && !novelAnalysis) issues.push("小说改编缺少 2.1-novel-analysis.json");
  if (!hasExactKeys(outline, topLevelKeys)) issues.push("顶层字段必须与 outline.json5 一致");
  const roleNameMappings = validateRoleNameMappings(outline, template, issues, { requiresTranslation });
  const titleIssue = renameTitle
    ? rewrittenTitleIssue(scriptTitle(outline), userInput.project?.source_script?.display_name)
    : retainedProjectTitleIssue(scriptTitle(outline), userInput.project);
  if (titleIssue) issues.push(titleIssue);
  const englishTitleIssue = renameTitle
    ? englishScriptTitleIssue(englishScriptTitle(outline), { requiresEnglishTitle })
    : englishScriptTitle(outline) ? "非剧本改写项目无需填写英文剧本名称" : "";
  if (englishTitleIssue) issues.push(englishTitleIssue);
  requireText(outline["故事梗概"], "故事梗概", issues);
  const opening = outline["开篇"];
  const scenarioFields = novelTask ? ["原著剧情单元"] : [];
  if (!hasKeysWithOptional(opening, openingKeys, scenarioFields)) {
    issues.push("开篇字段必须与 outline.json5 一致");
  } else {
    if (novelTask) validateNovelSourceUnits(opening["原著剧情单元"], "开篇", novelUnitIds, issues);
    requireText(opening["开篇描述"], "开篇描述", issues);
    checkNames(opening["关键角色"], "开篇的关键角色", issues, roleNameMappings.localizedNames);
    const openingEpisodes = opening["剧集"];
    if (!Array.isArray(openingEpisodes) || openingEpisodes.length !== 1) {
      issues.push("开篇必须且只能包含第 1 集");
    } else {
      checkEpisode(openingEpisodes[0], "开篇第 1 集", 1, episodeKeys, ideaKeys, issues, roleNameMappings.localizedNames);
    }
  }
  const units = outline["剧情单元"];
  if (!Array.isArray(units) || units.length === 0) {
    issues.push("剧情单元至少需要一个单元");
  } else {
    let expectedEpisode = 2;
    units.forEach((unit, unitIndex) => {
      const unitLabel = `第 ${unitIndex + 1} 个剧情单元`;
      if (!hasKeysWithOptional(unit, unitKeys, scenarioFields)) {
        issues.push(`${unitLabel}字段必须与 outline.json5 一致`);
        return;
      }
      if (novelTask) validateNovelSourceUnits(unit["原著剧情单元"], unitLabel, novelUnitIds, issues);
      requireText(unit["单元名称"], `${unitLabel}的单元名称`, issues);
      requireText(unit["单元描述"], `${unitLabel}的单元描述`, issues);
      checkNames(unit["关键角色"], `${unitLabel}的关键角色`, issues, roleNameMappings.localizedNames);
      const episodes = unit["剧集"];
      if (!Array.isArray(episodes) || episodes.length === 0) {
        issues.push(`${unitLabel}至少需要一集`);
        return;
      }
      episodes.forEach((episode, episodeIndex) => {
        const episodeLabel = `${unitLabel}第 ${episodeIndex + 1} 集`;
        checkEpisode(episode, episodeLabel, expectedEpisode, episodeKeys, ideaKeys, issues, roleNameMappings.localizedNames);
        expectedEpisode += 1;
      });
    });
  }
  const actualEpisodeCount = outlineEpisodeCount(opening, units);
  if (actualEpisodeCount !== targetEpisodeCount) {
    issues.push(`剧本大纲总集数必须为 ${targetEpisodeCount} 集，当前为 ${actualEpisodeCount} 集`);
  }
  if (novelTask) {
    validateNovelOutlineCapacity(opening, units, adaptationPlan, issues);
    validateNovelDecisionMapping(novelAnalysis, opening, units, issues);
  }
  if (issues.length) return { ok: false, issues };

  const outputRelativePath = outlineDocumentRelativePath(outline);
  const outputPath = path.join(workspaceDir, outputRelativePath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, renderOutline(outline, { requiresTranslation }), "utf8");
  await updateProgress({
    workspace: workspaceDir,
    stage: "outline_rewrite",
    status: "completed",
    updatedBy,
    nextSkill: "character_rewrite",
    outputFiles: ["3.1-outline.json", outputRelativePath],
    titleConfirmation: renameTitle ? {
      status: "pending",
      title: scriptTitle(outline),
      english_title: englishScriptTitle(outline)
    } : undefined,
    preserveConfirmedTitleWhenUnchanged: true
  });
  const executionStrategy = validateExecution
    ? await loadStageExecutionStrategy(workspaceDir, "outline_rewrite")
    : { snapshot: null };
  return {
    ok: true,
    outline_file: path.join(workspaceDir, "3.1-outline.json"),
    output_file: outputPath,
    quality_check: {
      passed: true,
      principle_review_criteria: (executionStrategy.snapshot?.principles || []).map((item) => ({
        principle_id: item.id,
        title: item.title,
        version: item.version,
        review_criteria: item.review_criteria
      }))
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await checkOutline(args.workspace, args.updatedBy);
    if (!result.ok) {
      const text = result.issues.join("\n");
      const nextAction = /执行策略/u.test(text)
        ? "先重新调用执行策略并阅读新文件，再重新检查。"
        : /执行规范|项目信息|用户要求或偏好/u.test(text)
          ? "先重新调用初始化剧本大纲并阅读新执行规范，再重新生成执行策略。"
          : "只修复 3.1-outline.json 中返回的问题后重新检查。";
      process.stderr.write(`${JSON.stringify({ ...result, stage: "outline_rewrite", tool: "check", next_action: nextAction }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ ...result, message: "剧本大纲已通过检查并生成展示文件。", next_action: "可以执行 character_rewrite。" }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "outline_rewrite", tool: "check", message: error.message, next_action: "检查 3.1-outline.json 的路径和 JSON 格式后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
