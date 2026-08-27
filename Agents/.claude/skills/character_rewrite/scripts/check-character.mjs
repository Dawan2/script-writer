#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { englishNameByChineseName } from "../../outline_rewrite/scripts/role-name-map.mjs";
import { hasCompletedFullScript } from "../../../tools/script-artifacts.mjs";
import {
  loadStageExecutionStrategy,
  shouldValidateStageExecution,
  stageExecutionSpecIssues,
  stageExecutionStrategyIssues
} from "../../_shared/scripts/stage-execution-spec.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../references/character.json5");

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

function requireText(value, label, issues) {
  if (typeof value !== "string" || !value.trim()) issues.push(`${label}必须是非空字符串`);
}

function requireShortText(value, label, maxLength, issues) {
  requireText(value, label, issues);
  if (typeof value === "string" && value.trim() && Array.from(value.trim()).length > maxLength) {
    issues.push(`${label}不能超过 ${maxLength} 个字符`);
  }
}

function getOutlineInfo(outline) {
  if (!outline || typeof outline !== "object" || Array.isArray(outline) || !Array.isArray(outline["剧情单元"])) {
    throw new Error("3.1-outline.json 缺少剧情单元");
  }
  const roles = [];
  const roleSet = new Set();
  const units = new Set();
  const addRoles = (values) => {
    if (!Array.isArray(values)) return;
    values.forEach((value) => {
      const name = typeof value === "string" ? value.trim() : "";
      if (name && !roleSet.has(name)) {
        roleSet.add(name);
        roles.push(name);
      }
    });
  };
  const opening = outline["开篇"];
  if (opening && typeof opening === "object" && !Array.isArray(opening)) {
    units.add("开篇");
    addRoles(opening["关键角色"]);
    if (Array.isArray(opening["剧集"])) opening["剧集"].forEach((episode) => addRoles(episode?.["关键角色"]));
  }
  outline["剧情单元"].forEach((unit) => {
    const unitName = typeof unit?.["单元名称"] === "string" ? unit["单元名称"].trim() : "";
    if (unitName) units.add(unitName);
    addRoles(unit?.["关键角色"]);
    if (Array.isArray(unit?.["剧集"])) unit["剧集"].forEach((episode) => addRoles(episode?.["关键角色"]));
  });
  if (!roles.length || !units.size) throw new Error("3.1-outline.json 缺少可用的关键角色或剧情单元");
  return { roles, roleSet, units };
}

function tableCell(value) {
  return String(value ?? "")
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .replace(/\r?\n/gu, "<br>");
}

function showEnglishNames(userInput) {
  const project = userInput?.project;
  if (!project || typeof project !== "object") return true;
  if (project.distribution_brief?.requires_translation === false) return false;
  return !new Set(["国内", "中国大陆", "China", "Mainland China"]).has(String(project.target_region || "").trim());
}

function renderCharacters(characters, { englishNames, includeEnglishNames }) {
  const lines = ["# 角色小传"];
  characters.forEach((character) => {
    const chineseName = character["人物名称"];
    const englishName = includeEnglishNames ? englishNames.get(chineseName) : "";
    lines.push(
      "",
      `## ${chineseName}${englishName ? `（${englishName}）` : ""}`,
      "",
      "### 人物形象",
      "",
      `- 性别：${character["性别"]}｜国籍：${character["国籍"]}｜年龄：${character["年龄"]}`,
      `- 身份：${character["身份"]}`,
      `- 外貌：${character["外貌"]}`,
      `- 穿着：${character["穿着"]}`,
      `- 性格：${character["性格"]}`,
      "",
      "### 人物内核",
      "",
      `- 核心诉求：${character["核心诉求"]}`,
      `- 人物难题：${character["人物难题"]}`,
      `- 关系与弧光：${character["关系与弧光"]}`
    );
    lines.push(
      "",
      "### 阶段变化",
      "",
      "| 故事阶段 | 身份与处境 | 人物形象 | 口吻 |",
      "| --- | --- | --- | --- |"
    );
    character["阶段变化"].forEach((stage) => {
      lines.push(
        `| ${tableCell(stage["故事阶段"])} | ${tableCell(stage["身份与处境"])} | ${tableCell(stage["人物形象"])} | ${tableCell(stage["口吻"])} |`
      );
    });
  });
  return `${lines.join("\n")}\n`;
}

function compactText(value) {
  return typeof value === "string" ? value.replace(/[\s，。；、：,.!?！？]/gu, "").trim() : "";
}

function validateStagePortrait(character, stage, label, issues) {
  const portrait = compactText(stage["人物形象"]);
  if (!portrait) return;
  const missing = ["年龄", "身份", "外貌", "穿着", "性格"].filter((field) => {
    const source = compactText(character[field]);
    return source && !portrait.includes(source);
  });
  if (missing.length) {
    issues.push(`${label}的人物形象必须完整写入${missing.join("、")}，不能只写相对上一阶段的变化`);
  }
}

function validateRelationshipGraph(characters, relationshipKeys, issues) {
  const names = new Set(characters
    .map((character) => typeof character?.["人物名称"] === "string" ? character["人物名称"].trim() : "")
    .filter(Boolean));
  const protagonists = characters.filter((character) => character?.["是否主角"] === true);
  if (protagonists.length !== 1) {
    issues.push("人物关系图谱必须且只能指定一位主角");
  }

  const adjacency = new Map([...names].map((name) => [name, new Set()]));
  characters.forEach((character, characterIndex) => {
    const label = `第 ${characterIndex + 1} 位角色`;
    const name = typeof character?.["人物名称"] === "string" ? character["人物名称"].trim() : "";
    if (typeof character?.["是否主角"] !== "boolean") {
      issues.push(`${label}的是否主角必须是布尔值`);
    }
    if (!Array.isArray(character?.["人物关系"])) {
      issues.push(`${label}的人物关系必须是数组`);
      return;
    }
    if (characters.length > 1 && !character["人物关系"].length) {
      issues.push(`${label}至少需要一条人物关系`);
    }
    const linkedNames = new Set();
    character["人物关系"].forEach((relation, relationIndex) => {
      const relationLabel = `${label}第 ${relationIndex + 1} 条人物关系`;
      if (!hasExactKeys(relation, relationshipKeys)) {
        issues.push(`${relationLabel}字段必须与 character.json5 一致`);
        return;
      }
      requireText(relation["关联人物"], `${relationLabel}的关联人物`, issues);
      requireShortText(relation["关系"], `${relationLabel}的关系`, 12, issues);
      const linkedName = typeof relation["关联人物"] === "string" ? relation["关联人物"].trim() : "";
      if (!linkedName || !name) return;
      if (linkedName === name) {
        issues.push(`${relationLabel}不能关联角色自身`);
        return;
      }
      if (!names.has(linkedName)) {
        issues.push(`${relationLabel}的关联人物必须是剧本大纲中的关键角色`);
        return;
      }
      if (linkedNames.has(linkedName)) {
        issues.push(`${label}与“${linkedName}”的人物关系重复`);
        return;
      }
      linkedNames.add(linkedName);
      adjacency.get(name)?.add(linkedName);
      adjacency.get(linkedName)?.add(name);
    });
  });

  if (names.size > 1 && protagonists.length === 1) {
    const protagonistName = typeof protagonists[0]?.["人物名称"] === "string"
      ? protagonists[0]["人物名称"].trim()
      : "";
    if (!names.has(protagonistName)) return;
    const visited = new Set([protagonistName]);
    const queue = [protagonistName];
    while (queue.length) {
      const current = queue.shift();
      adjacency.get(current)?.forEach((linkedName) => {
        if (!visited.has(linkedName)) {
          visited.add(linkedName);
          queue.push(linkedName);
        }
      });
    }
    const disconnected = [...names].filter((name) => !visited.has(name));
    if (disconnected.length) {
      issues.push(`人物关系图谱存在未连接角色：${disconnected.join("、")}`);
    }
  }
}

export async function checkCharacter(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [template, outline, raw, userInput] = await Promise.all([
    fs.readFile(templatePath, "utf8").then(parseTemplate),
    fs.readFile(path.join(workspaceDir, "3.1-outline.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspaceDir, "4.1-character.json"), "utf8"),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse).catch((error) => {
      if (error?.code === "ENOENT") return {};
      throw error;
    })
  ]);
  const characters = JSON.parse(raw);
  if (!Array.isArray(characters)) return { ok: false, issues: ["4.1-character.json 顶层必须是数组"] };
  if (!Array.isArray(template) || !template[0] || typeof template[0] !== "object") {
    throw new Error("character.json5 缺少角色模板");
  }
  const outlineInfo = getOutlineInfo(outline);
  const characterKeys = Object.keys(template[0]);
  const stageKeys = Object.keys(template[0]["阶段变化"]?.[0] || {});
  const relationshipKeys = Object.keys(template[0]["人物关系"]?.[0] || {});
  const issues = [];
  const validateExecution = await shouldValidateStageExecution(workspaceDir, "character_rewrite");
  if (validateExecution) {
    issues.push(...await stageExecutionSpecIssues(workspaceDir, "character_rewrite", userInput));
    issues.push(...await stageExecutionStrategyIssues(workspaceDir, "character_rewrite", userInput));
  }
  if (!characters.length) issues.push("至少需要一位关键角色");
  const names = new Set();
  characters.forEach((character, characterIndex) => {
    const label = `第 ${characterIndex + 1} 位角色`;
    if (!hasExactKeys(character, characterKeys)) {
      issues.push(`${label}字段必须与 character.json5 一致`);
      return;
    }
    requireText(character["人物名称"], `${label}的人物名称`, issues);
    const name = typeof character["人物名称"] === "string" ? character["人物名称"].trim() : "";
    if (name) {
      if (names.has(name)) issues.push(`人物名称“${name}”重复`);
      names.add(name);
    }
    ["性别", "国籍", "年龄", "身份", "外貌", "穿着", "性格", "所属阵营", "核心诉求", "人物难题", "关系与弧光"].forEach((field) => requireText(character[field], `${label}的${field}`, issues));
    const stages = character["阶段变化"];
    if (!Array.isArray(stages) || !stages.length) {
      issues.push(`${label}至少需要一条阶段变化`);
      return;
    }
    const stageNames = new Set();
    stages.forEach((stage, stageIndex) => {
      const stageLabel = `${label}第 ${stageIndex + 1} 条阶段变化`;
      if (!hasExactKeys(stage, stageKeys)) {
        issues.push(`${stageLabel}字段必须与 character.json5 一致`);
        return;
      }
      requireText(stage["故事阶段"], `${stageLabel}的故事阶段`, issues);
      const stageName = typeof stage["故事阶段"] === "string" ? stage["故事阶段"].trim() : "";
      if (stageName) {
        if (!outlineInfo.units.has(stageName)) issues.push(`${stageLabel}的故事阶段必须对应 3.1-outline.json 中的单元名称`);
        if (stageNames.has(stageName)) issues.push(`${label}的故事阶段“${stageName}”重复`);
        stageNames.add(stageName);
      }
      ["身份与处境", "人物形象", "口吻"].forEach((field) => requireText(stage[field], `${stageLabel}的${field}`, issues));
      validateStagePortrait(character, stage, stageLabel, issues);
    });
  });
  const missing = outlineInfo.roles.filter((name) => !names.has(name));
  const extra = [...names].filter((name) => !outlineInfo.roleSet.has(name));
  if (missing.length) issues.push(`缺少剧本大纲中的关键角色：${missing.join("、")}`);
  if (extra.length) issues.push(`存在剧本大纲中未定义的角色：${extra.join("、")}`);
  if (!relationshipKeys.length) throw new Error("character.json5 缺少人物关系模板");
  validateRelationshipGraph(characters, relationshipKeys, issues);
  if (issues.length) return { ok: false, issues };

  const includeEnglishNames = showEnglishNames(userInput);
  const englishNames = includeEnglishNames ? englishNameByChineseName(outline) : new Map();
  const progress = await fs.readFile(path.join(workspaceDir, "1.2-project-progress.json"), "utf8").then(JSON.parse);
  const previousFull = progress.stages?.full_generate || {};
  const nextSkill = hasCompletedFullScript(userInput.project, previousFull)
    ? "full_generate"
    : "trial_generate";

  const outputPath = path.join(workspaceDir, "output", "角色小传.md");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, renderCharacters(characters, { englishNames, includeEnglishNames }), "utf8");
  await updateProgress({
    workspace: workspaceDir,
    stage: "character_rewrite",
    status: "completed",
    updatedBy,
    nextSkill,
    outputFiles: ["4.1-character.json", "output/角色小传.md"]
  });
  const executionStrategy = validateExecution
    ? await loadStageExecutionStrategy(workspaceDir, "character_rewrite")
    : { snapshot: null };
  return {
    ok: true,
    character_file: path.join(workspaceDir, "4.1-character.json"),
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
    const result = await checkCharacter(args.workspace, args.updatedBy);
    if (!result.ok) {
      const text = result.issues.join("\n");
      const nextAction = /执行策略/u.test(text)
        ? "先重新调用执行策略并阅读新文件，再重新检查。"
        : /执行规范|项目信息|用户要求或偏好/u.test(text)
          ? "先重新调用初始化角色小传并阅读新执行规范，再重新生成执行策略。"
          : "只修复 4.1-character.json 中返回的问题后重新检查。";
      process.stderr.write(`${JSON.stringify({ ...result, stage: "character_rewrite", tool: "check", next_action: nextAction }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ ...result, message: "角色小传已通过检查并生成展示文件。" }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "character_rewrite", tool: "check", message: error.message, next_action: "检查 4.1-character.json、3.1-outline.json 的路径和 JSON 格式后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
