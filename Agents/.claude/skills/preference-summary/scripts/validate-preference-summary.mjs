#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ALLOWED_SCOPES = new Set([
  "global",
  "world_view",
  "outline_rewrite",
  "character_rewrite",
  "trial_generate",
  "full_generate",
  "foreign_review"
]);
const RESULT_KEYS = ["schema_version", "preferences"];

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--evidence" || argv[2] !== "--output") {
    throw new Error("请使用 --evidence <证据文件> --output <输出文件>");
  }
  return { evidencePath: path.resolve(argv[1]), outputPath: path.resolve(argv[3]) };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function evidenceRefs(evidence) {
  const refs = new Set();
  for (const field of ["manual_inputs", "manual_messages", "manual_adjustments"]) {
    const entries = evidence[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (isPlainObject(entry) && typeof entry.ref === "string" && entry.ref.trim()) refs.add(entry.ref.trim());
    }
  }
  return refs;
}

function validateEvidence(evidence) {
  const issues = [];
  if (!isPlainObject(evidence)) return ["偏好总结证据必须是 JSON 对象"];
  if (evidence.schema_version !== "1.0.0") issues.push("偏好总结证据 schema_version 必须为 1.0.0");
  for (const field of ["manual_inputs", "manual_messages", "manual_adjustments"]) {
    if (!Array.isArray(evidence[field])) issues.push(`偏好总结证据缺少 ${field} 数组`);
  }
  return issues;
}

function validateResult(result, evidence) {
  const issues = [];
  if (!isPlainObject(result)) return ["偏好总结结果必须是 JSON 对象"];
  const actualKeys = Object.keys(result).sort();
  const expectedKeys = [...RESULT_KEYS].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    issues.push("偏好总结结果只能包含 schema_version 和 preferences");
  }
  if (result.schema_version !== "1.0.0") issues.push("偏好总结结果 schema_version 必须为 1.0.0");
  if (!Array.isArray(result.preferences)) {
    issues.push("preferences 必须是数组");
    return issues;
  }
  if (result.preferences.length > 12) issues.push("一次最多提炼 12 条待确认偏好");
  const validRefs = evidenceRefs(evidence);
  const seenContents = new Set();
  result.preferences.forEach((item, index) => {
    const label = `第 ${index + 1} 条偏好`;
    if (!isPlainObject(item)) {
      issues.push(`${label}必须是对象`);
      return;
    }
    const keys = Object.keys(item).sort();
    const expected = ["content", "scopes", "evidence_refs", "rationale"].sort();
    if (keys.length !== expected.length || keys.some((key, keyIndex) => key !== expected[keyIndex])) {
      issues.push(`${label}只能包含 content、scopes、evidence_refs、rationale`);
    }
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) issues.push(`${label}的 content 不能为空`);
    if (content.length > 500) issues.push(`${label}的 content 不能超过 500 个字符`);
    const normalizedContent = content.toLocaleLowerCase();
    if (normalizedContent && seenContents.has(normalizedContent)) issues.push(`${label}与前面的建议重复`);
    if (normalizedContent) seenContents.add(normalizedContent);

    if (!Array.isArray(item.scopes) || item.scopes.length === 0) {
      issues.push(`${label}至少需要一个 scopes`);
    } else {
      const scopes = item.scopes.map((scope) => typeof scope === "string" ? scope.trim() : "");
      if (scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) issues.push(`${label}包含不支持的 scope`);
      if (new Set(scopes).size !== scopes.length) issues.push(`${label}的 scopes 不能重复`);
      if (scopes.includes("global") && scopes.length !== 1) issues.push(`${label}的 global 不能与其他 scope 同时使用`);
    }

    if (!Array.isArray(item.evidence_refs) || item.evidence_refs.length === 0) {
      issues.push(`${label}至少需要一个 evidence_refs`);
    } else {
      const refs = item.evidence_refs.map((ref) => typeof ref === "string" ? ref.trim() : "");
      if (refs.some((ref) => !validRefs.has(ref))) issues.push(`${label}引用了不存在或非手工的证据`);
      if (new Set(refs).size !== refs.length) issues.push(`${label}的 evidence_refs 不能重复`);
    }

    const rationale = typeof item.rationale === "string" ? item.rationale.trim() : "";
    if (!rationale) issues.push(`${label}的 rationale 不能为空`);
    if (rationale.length > 1000) issues.push(`${label}的 rationale 不能超过 1000 个字符`);
  });
  return issues;
}

export async function validatePreferenceSummary({ evidencePath, outputPath }) {
  const [evidenceText, resultText] = await Promise.all([
    fs.readFile(evidencePath, "utf8"),
    fs.readFile(outputPath, "utf8")
  ]);
  const evidence = JSON.parse(evidenceText);
  const result = JSON.parse(resultText);
  const issues = [...validateEvidence(evidence), ...validateResult(result, evidence)];
  return { ok: issues.length === 0, issues, result };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await validatePreferenceSummary(parseArgs(process.argv.slice(2)));
    if (!result.ok) {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        tool: "validate-preference-summary",
        message: result.issues.join("；"),
        issues: result.issues,
        next_action: "只修复返回的字段、范围或证据引用问题后重新检查。"
      })}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        message: "待确认偏好已通过检查。",
        next_action: "后台将以默认停用状态保存建议。",
        details: { result: result.result }
      })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      tool: "validate-preference-summary",
      message: error instanceof Error ? error.message : String(error),
      next_action: "检查证据文件和输出 JSON 后重试。"
    })}\n`);
    process.exitCode = 1;
  }
}
