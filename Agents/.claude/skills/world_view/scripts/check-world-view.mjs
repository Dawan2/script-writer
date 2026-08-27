#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateProgress } from "../../../tools/update-progress.mjs";
import { assertScriptProfileResolved } from "../../../tools/script-profile.mjs";
import {
  loadStageExecutionStrategy,
  stageExecutionSpecIssues,
  stageExecutionStrategyIssues
} from "../../_shared/scripts/stage-execution-spec.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const templatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../references/world-view.json5");

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

function nextActionForIssues(issues) {
  const text = issues.join("\n");
  if (/剧本设定尚未完成/u.test(text)) {
    return "先解析并写回仍为自动适配的剧本标签，再重新阅读执行规范并检查。";
  }
  if (/执行策略|策略公式/u.test(text)) {
    return "先重新调用“执行策略”工具并阅读新的执行策略，再重新检查。";
  }
  if (/执行规范|项目信息|用户要求或偏好/u.test(text)) {
    return "先重新调用“初始化世界观”并阅读新的执行规范，再重新检查。";
  }
  return "只修复返回问题指向的世界观文件内容，再重新检查。";
}

export async function checkWorldView(workspace, updatedBy = "admin") {
  const workspaceDir = path.resolve(workspace);
  const [template, raw, userInput] = await Promise.all([
    fs.readFile(templatePath, "utf8").then(parseTemplate),
    fs.readFile(path.join(workspaceDir, "2.1-world-view.json"), "utf8"),
    fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8").then(JSON.parse)
  ]);
  const worldView = JSON.parse(raw);
  const expectedKeys = Object.keys(template);
  const mappingKeys = Object.keys(template["关键概念映射"]?.[0] || {});
  const issues = [];
  issues.push(...await stageExecutionSpecIssues(workspaceDir, "world_view", userInput));
  issues.push(...await stageExecutionStrategyIssues(workspaceDir, "world_view", userInput));
  try {
    assertScriptProfileResolved(userInput.project, "world_view");
  } catch (error) {
    issues.push(error.message);
  }
  if (!hasExactKeys(worldView, expectedKeys)) issues.push("顶层字段必须与 world-view.json5 一致");
  if (typeof worldView["世界观描述"] !== "string" || !worldView["世界观描述"].trim()) {
    issues.push("世界观描述必须是非空字符串");
  }
  const mappings = worldView["关键概念映射"];
  if (!Array.isArray(mappings)) {
    issues.push("关键概念映射必须是列表");
  } else {
    mappings.forEach((mapping, index) => {
      if (!hasExactKeys(mapping, mappingKeys)) {
        issues.push(`第 ${index + 1} 条映射字段必须与 world-view.json5 一致`);
        return;
      }
      for (const key of mappingKeys) {
        if (typeof mapping[key] !== "string" || !mapping[key].trim()) {
          issues.push(`第 ${index + 1} 条映射的“${key}”不能为空`);
        }
      }
    });
  }
  if (issues.length) {
    const uniqueIssues = [...new Set(issues)];
    return { ok: false, issues: uniqueIssues, next_action: nextActionForIssues(uniqueIssues) };
  }
  await updateProgress({
    workspace: workspaceDir,
    stage: "world_view",
    status: "completed",
    updatedBy,
    nextSkill: "outline_rewrite",
    outputFiles: ["2.1-world-view.json"]
  });
  const executionStrategy = await loadStageExecutionStrategy(workspaceDir, "world_view");
  return {
    ok: true,
    world_view_file: path.join(workspaceDir, "2.1-world-view.json"),
    quality_check: {
      passed: true,
      checks: [
        "世界观交付格式已通过检查",
        ...(executionStrategy.snapshot?.principles || []).map((item) => `已锁定创作原则：${item.title}`)
      ],
      warnings: [],
      principle_review_criteria: (executionStrategy.snapshot?.principles || []).map((item) => ({
        principle_id: item.id,
        title: item.title,
        version: item.version,
        review_criteria: item.review_criteria
      }))
    },
    next_action: "可以执行 outline_rewrite。"
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await checkWorldView(args.workspace, args.updatedBy);
    if (!result.ok) {
      process.stderr.write(`${JSON.stringify({ ...result, stage: "world_view", tool: "check" }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ ...result, message: "世界观文件已通过检查。" }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, stage: "world_view", tool: "check", message: error.message, next_action: "检查世界观文件路径和 JSON 格式后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
