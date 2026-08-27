#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeStageExecutionStrategy } from "../../_shared/scripts/stage-execution-spec.mjs";

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") throw new Error("请使用 --workspace <项目目录>");
  return path.resolve(agentRoot, argv[1]);
}

export async function getOutlineExecutionStrategy(workspace, options = {}) {
  const workspaceDir = path.resolve(workspace);
  const userInput = JSON.parse(await fs.readFile(path.join(workspaceDir, "1.1-user-input.json"), "utf8"));
  const result = await writeStageExecutionStrategy({
    workspace: workspaceDir,
    stage: "outline_rewrite",
    userInput,
    options
  });
  return {
    workspace_dir: workspaceDir,
    execution_strategy_file: result.paths.strategy_markdown,
    knowledge_status: result.snapshot.knowledge_status,
    formula_count: result.snapshot.formulas.length,
    principle_count: result.snapshot.principles.length
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await getOutlineExecutionStrategy(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      ...result,
      message: `执行策略已生成，请阅读\`${result.execution_strategy_file}\`后继续。`,
      next_action: "阅读执行策略并按 Skill 步骤继续。"
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      stage: "outline_rewrite",
      tool: "get-execution-strategy",
      message: error.message,
      next_action: /执行规范/u.test(error.message)
        ? "先重新调用初始化剧本大纲，再重新调用执行策略。"
        : "修复返回问题后重新调用执行策略。"
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
