#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { proposalSkeleton, validateEvidence } from "./retrospective-utils.mjs";

function parseArgs(argv) {
  if (argv.length !== 6 || argv[0] !== "--workspace" || argv[2] !== "--evidence" || argv[4] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --evidence <证据文件> --updated-by <用户>");
  }
  return { workspace: path.resolve(argv[1]), evidence: path.resolve(argv[3]), updatedBy: argv[5] || "admin" };
}

async function writeIfBlank(filePath, content) {
  const existing = await fs.readFile(filePath, "utf8").catch(() => "");
  if (existing.trim()) return false;
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

export async function initializeRetrospective(workspace, evidenceFile, updatedBy = "admin") {
  const [workspaceStat, evidenceText] = await Promise.all([
    fs.stat(workspace).catch(() => null),
    fs.readFile(evidenceFile, "utf8")
  ]);
  if (!workspaceStat?.isDirectory()) throw new Error("项目目录不存在");
  const evidence = JSON.parse(evidenceText);
  const issues = validateEvidence(evidence);
  if (issues.length) throw new Error(`复盘证据不合格：${issues.join("；")}`);
  const directory = path.join(workspace, "retrospective");
  const storedEvidence = path.join(directory, "evidence.json");
  const proposal = path.join(directory, "skill-improvement-proposal.md");
  await fs.mkdir(directory, { recursive: true });
  if (path.resolve(evidenceFile) !== storedEvidence) await fs.writeFile(storedEvidence, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await writeIfBlank(proposal, proposalSkeleton());
  return {
    workspace_dir: workspace,
    evidence_file: storedEvidence,
    proposal_file: proposal,
    updated_by: updatedBy
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await initializeRetrospective(args.workspace, args.evidence, args.updatedBy);
    process.stdout.write(`${JSON.stringify({ ok: true, message: "项目复盘已初始化。", next_action: "仅依据证据填写提案；证据不足时写不建议本次修改。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "init-retrospective", message: error.message, next_action: "修复证据文件或项目目录后重新初始化。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
