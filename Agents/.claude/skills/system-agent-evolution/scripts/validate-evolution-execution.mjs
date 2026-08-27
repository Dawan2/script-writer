#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateEvolutionExecution } from "./evolution-contract-tools.mjs";

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--execution" || argv[2] !== "--verification") {
    throw new Error("请使用 --execution <执行记录> --verification <验证结果>");
  }
  return { executionPath: path.resolve(argv[1]), verificationPath: path.resolve(argv[3]) };
}

export async function validateExecution(argv = process.argv.slice(2)) {
  const { executionPath, verificationPath } = parseArgs(argv);
  const details = await validateEvolutionExecution({ executionPath, verificationPath });
  return {
    ok: true,
    tool: "validate-evolution-execution",
    message: "执行记录已与实际变更和系统验证结果一致。",
    next_action: "保留记录和回滚点，结束本次获批优化。",
    details
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await validateExecution(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      tool: "validate-evolution-execution",
      message: error instanceof Error ? error.message : String(error),
      next_action: "只修复执行记录或验证结果中返回的问题后重新校验。"
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
