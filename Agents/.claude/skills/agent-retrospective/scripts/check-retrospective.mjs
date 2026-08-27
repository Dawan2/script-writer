#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { proposalAssessment, sha256, validateEvidence } from "./retrospective-utils.mjs";

function parseArgs(argv) {
  if (argv.length !== 6 || argv[0] !== "--workspace" || argv[2] !== "--proposal-file" || argv[4] !== "--updated-by") {
    throw new Error("请使用 --workspace <项目目录> --proposal-file <提案文件> --updated-by <用户>");
  }
  return { workspace: path.resolve(argv[1]), proposal: path.resolve(argv[3]), updatedBy: argv[5] || "admin" };
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function checkRetrospective(workspace, proposalFile, updatedBy = "admin") {
  const directory = path.join(workspace, "retrospective");
  if (!isInside(directory, proposalFile) || path.extname(proposalFile) !== ".md") throw new Error("提案文件必须位于项目的 retrospective/ 目录内");
  const [proposal, evidenceText] = await Promise.all([
    fs.readFile(proposalFile, "utf8"),
    fs.readFile(path.join(directory, "evidence.json"), "utf8")
  ]);
  const evidence = JSON.parse(evidenceText);
  const evidenceIssues = validateEvidence(evidence);
  if (evidenceIssues.length) return { ok: false, issues: evidenceIssues };
  const assessment = proposalAssessment(proposal, evidence);
  if (assessment.issues.length) return { ok: false, issues: assessment.issues };
  const metadata = {
    schema_version: "1.0.0",
    status: "pending_human_review",
    proposal_file: path.relative(workspace, proposalFile),
    proposal_sha256: sha256(proposal),
    evidence_file: "retrospective/evidence.json",
    cited_evidence_ids: assessment.citedIds,
    recommendation: assessment.noChange ? "no_change" : "pending_change_review",
    updated_at: new Date().toISOString(),
    updated_by: updatedBy
  };
  const metadataPath = proposalFile.replace(/\.md$/iu, ".json");
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return { ok: true, proposal_file: proposalFile, metadata_file: metadataPath, recommendation: metadata.recommendation };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await checkRetrospective(args.workspace, args.proposal, args.updatedBy);
    if (!result.ok) {
      process.stderr.write(`${JSON.stringify({ ...result, tool: "check-retrospective", next_action: "只修复提案中返回的证据引用或章节问题后重新检查。" }, null, 2)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ ...result, message: "复盘提案已通过检查并等待人工评审。", next_action: "在获得明确批准前不要修改生产 Skill。" }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "check-retrospective", message: error.message, next_action: "检查项目目录、证据副本和提案文件后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
