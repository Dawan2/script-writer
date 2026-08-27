#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadStageExecutionStrategy,
  stageExecutionStrategyIssues,
  strategyFormulaPayload
} from "../skills/_shared/scripts/stage-execution-spec.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.join(agentRoot, "workspaces");
const SUPPORTED_STAGES = new Set([
  "world_view",
  "outline_rewrite",
  "character_rewrite",
  "trial_generate",
  "full_generate"
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || args[key.slice(2)] !== undefined) {
      throw new Error("请使用 --workspace <项目目录> --stage <创作阶段> --name <公式名称>");
    }
    args[key.slice(2)] = value;
  }
  if (!args.workspace || !SUPPORTED_STAGES.has(args.stage) || !args.name || Object.keys(args).length !== 3) {
    throw new Error("请使用 --workspace <项目目录> --stage <创作阶段> --name <公式名称>");
  }
  return args;
}

function resolveWorkspace(value) {
  const workspace = path.resolve(agentRoot, value);
  const relative = path.relative(workspaceRoot, workspace);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("项目目录必须位于 workspaces/ 下");
  }
  return workspace;
}

function nextActionForError(message) {
  if (/执行规范/u.test(message)) {
    return "先重新调用“初始化世界观”并阅读新的执行规范，再调用“执行策略”工具。";
  }
  if (/执行策略|项目信息|用户要求或偏好|剧本标签|策略公式/u.test(message)) {
    return "先重新调用“执行策略”工具并阅读新的执行策略，再读取公式。";
  }
  return "只能读取当前执行策略公式表中的公式名称。";
}

export async function getStrategyFormula({ workspace, stage, name }) {
  if (!SUPPORTED_STAGES.has(stage)) throw new Error("当前阶段不支持读取策略公式");
  const workspaceDir = resolveWorkspace(workspace);
  const userInput = JSON.parse(await fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8"));
  const issues = await stageExecutionStrategyIssues(workspaceDir, stage, userInput);
  if (issues.length) throw new Error(issues[0]);
  const { snapshot } = await loadStageExecutionStrategy(workspaceDir, stage);
  return strategyFormulaPayload(snapshot, name, stage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await getStrategyFormula(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      formula: result,
      message: "已读取当前任务中的策略公式，请按公式边界完成当前创作决策。"
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      tool: "get-strategy-formula",
      message: error.message,
      next_action: nextActionForError(error.message)
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
