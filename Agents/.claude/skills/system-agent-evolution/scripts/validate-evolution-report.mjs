#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateEvolutionAnalysis } from "./evolution-contract-tools.mjs";

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--evidence" || argv[2] !== "--report") {
    throw new Error("请使用 --evidence <证据文件> --report <报告文件>");
  }
  return { evidencePath: path.resolve(argv[1]), reportPath: path.resolve(argv[3]) };
}

export async function validateReport(argv = process.argv.slice(2)) {
  const { evidencePath, reportPath } = parseArgs(argv);
  const details = await validateEvolutionAnalysis({ evidencePath, reportPath });
  return {
    ok: true,
    tool: "validate-evolution-report",
    message: "进化分析报告已通过证据和结构校验。",
    next_action: "提交管理员审阅，只有获批方案才能进入执行。",
    details
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await validateReport(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      tool: "validate-evolution-report",
      message: error instanceof Error ? error.message : String(error),
      next_action: "只修复报告中的证据引用、章节或候选范围后重新校验。"
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
