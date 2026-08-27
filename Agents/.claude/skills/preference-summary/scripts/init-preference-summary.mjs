#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--evidence" || argv[2] !== "--output") {
    throw new Error("请使用 --evidence <证据文件> --output <输出文件>");
  }
  return { evidencePath: path.resolve(argv[1]), outputPath: path.resolve(argv[3]) };
}

function assertEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("偏好总结证据必须是 JSON 对象");
  }
  if (value.schema_version !== "1.0.0") {
    throw new Error("偏好总结证据 schema_version 必须为 1.0.0");
  }
  for (const field of ["manual_inputs", "manual_messages", "manual_adjustments"]) {
    if (!Array.isArray(value[field])) throw new Error(`偏好总结证据缺少 ${field} 数组`);
  }
}

async function writeJson(outputPath, value) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, outputPath);
}

export async function initializePreferenceSummary({ evidencePath, outputPath }) {
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  assertEvidence(evidence);
  await writeJson(outputPath, { schema_version: "1.0.0", preferences: [] });
  return { evidence_path: evidencePath, output_path: outputPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await initializePreferenceSummary(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      ok: true,
      message: "偏好复盘输出已初始化。",
      next_action: "仅从手工证据提炼待确认的跨项目偏好。",
      details: result
    })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      tool: "init-preference-summary",
      message: error instanceof Error ? error.message : String(error),
      next_action: "检查归档证据文件后重试。"
    })}\n`);
    process.exitCode = 1;
  }
}
