import fs from "node:fs/promises";

const REPORT_CONTRACT_PATH = new URL("../contracts/report-contract.json", import.meta.url);
const EXECUTION_CONTRACT_PATH = new URL("../contracts/execution-record-contract.json", import.meta.url);
const CITATION_RE = /\[((?:job|event|artifact_change|message|preference|raw_log):[^\]]+)\]/gu;

function compactLength(value) {
  return String(value || "").replace(/\s/gu, "").length;
}

function headingSections(markdown) {
  const lines = String(markdown || "").split(/\r?\n/u);
  const sections = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^##\s+(.+?)\s*$/u);
    if (!match) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^##\s+/u.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    sections.push({ heading: match[1].trim(), body: lines.slice(index + 1, end).join("\n").trim() });
  }
  return sections;
}

function sectionFor(markdown, label) {
  return headingSections(markdown).find((section) => section.heading.includes(label)) || null;
}

function subsectionBlocks(sectionBody) {
  const lines = String(sectionBody || "").split(/\r?\n/u);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^###\s+(.+?)\s*$/u);
    if (!match) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^#{2,3}\s+/u.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    blocks.push({ heading: match[1].trim(), body: lines.slice(index + 1, end).join("\n").trim() });
  }
  return blocks;
}

function labeledValue(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[:：]\\s*([^\\n]+)`, "u");
  return text.match(expression)?.[1]?.trim() || "";
}

function evidenceReferences(value) {
  const refs = new Set();
  if (Array.isArray(value)) {
    value.forEach((item) => evidenceReferences(item).forEach((ref) => refs.add(ref)));
  } else if (value && typeof value === "object") {
    if (typeof value.ref === "string" && value.ref.trim()) refs.add(value.ref.trim());
    Object.values(value).forEach((item) => evidenceReferences(item).forEach((ref) => refs.add(ref)));
  }
  return refs;
}

function citations(text) {
  return [...String(text || "").matchAll(CITATION_RE)].map((match) => match[1]);
}

function isConcreteSkillTarget(value) {
  return /(?:^|[^A-Za-z0-9_])Agents\/\.claude\/skills\/(?:[^/\s`]+\/)+(?:SKILL\.md|references\/[^\s`]+|scripts\/[^\s`]+)/u.test(
    String(value || "").replaceAll("\\", "/")
  );
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function validateEvolutionAnalysis({ evidencePath, reportPath }) {
  const [contract, evidence, report] = await Promise.all([
    readJson(REPORT_CONTRACT_PATH),
    readJson(evidencePath),
    fs.readFile(reportPath, "utf8")
  ]);
  const issues = [];
  for (const heading of contract.required_headings) {
    const section = sectionFor(report, heading);
    if (!section) issues.push(`缺少章节“${heading}”`);
    else if (compactLength(section.body) < contract.minimum_section_chars) issues.push(`章节“${heading}”缺少实质内容`);
  }
  const validRefs = evidenceReferences(evidence);
  const unknown = citations(report).filter((ref) => !validRefs.has(ref));
  if (unknown.length) issues.push(`引用了不存在的证据：${[...new Set(unknown)].slice(0, 5).join("、")}`);

  const recommendation = sectionFor(report, "优化建议");
  const blocks = subsectionBlocks(recommendation?.body || "");
  if (!blocks.length) {
    issues.push("优化建议必须包含优化项，或使用“不建议本次修改”分支");
  } else {
    const noChange = blocks.filter((block) => block.heading.includes("不建议本次修改"));
    if (noChange.length) {
      if (blocks.length !== 1) issues.push("“不建议本次修改”不能与优化项混用");
      for (const field of contract.no_change_fields) {
        if (compactLength(labeledValue(noChange[0].body, field)) < 4) {
          issues.push(`“不建议本次修改”缺少“${field}”`);
        }
      }
    } else {
      for (const block of blocks) {
        for (const field of contract.recommendation_fields) {
          if (compactLength(labeledValue(block.body, field)) < 4) {
            issues.push(`优化项“${block.heading}”缺少“${field}”`);
          }
        }
        if (!citations(block.body).length) issues.push(`优化项“${block.heading}”缺少可追溯证据`);
        if (!isConcreteSkillTarget(labeledValue(block.body, "调整对象"))) {
          issues.push(`优化项“${block.heading}”的调整对象必须指向具体 Skill、reference 或脚本`);
        }
      }
    }
  }
  if (issues.length) throw new Error(`进化报告未通过：${issues.join("；")}`);
  return { recommendation_count: blocks.length, evidence_ref_count: validRefs.size };
}

export async function validateEvolutionExecution({ executionPath, verificationPath }) {
  const [contract, verification, execution] = await Promise.all([
    readJson(EXECUTION_CONTRACT_PATH),
    readJson(verificationPath),
    fs.readFile(executionPath, "utf8")
  ]);
  const issues = [];
  if (!/^#\s+执行记录\s*$/mu.test(execution)) issues.push("执行记录必须以“# 执行记录”开头");
  for (const heading of contract.required_headings) {
    const section = sectionFor(execution, heading);
    if (!section) issues.push(`缺少章节“${heading}”`);
    else if (compactLength(section.body) < contract.minimum_section_chars) issues.push(`章节“${heading}”缺少实质内容`);
  }
  if (verification?.status !== "passed") issues.push("系统验证未通过");
  const commands = Array.isArray(verification?.commands) ? verification.commands : [];
  for (const command of contract.required_commands) {
    if (!commands.some((item) => item?.command === command && item?.status === "passed")) {
      issues.push(`系统验证缺少通过的“${command}”结果`);
    }
  }
  const changedFiles = Array.isArray(verification?.changed_files) ? verification.changed_files : [];
  const actualChangeText = sectionFor(execution, "实际变更")?.body || "";
  if (changedFiles.length) {
    for (const file of changedFiles) {
      if (!actualChangeText.includes(file)) issues.push(`实际变更章节未镜像文件：${file}`);
    }
    const declared = [...actualChangeText.matchAll(/Agents\/\.claude\/skills\/[^\s`，。；,;：:）)]+/gu)]
      .map((match) => match[0]);
    const unexpected = declared.filter((file) => !changedFiles.includes(file));
    if (unexpected.length) issues.push(`实际变更章节包含未发生的文件：${unexpected.join("、")}`);
  } else if (!/未修改生产\s*Skill/u.test(actualChangeText)) {
    issues.push("没有生产文件变更时，实际变更章节必须明确“未修改生产 Skill”");
  }
  if (issues.length) throw new Error(`执行记录未通过：${issues.join("；")}`);
  return { changed_file_count: changedFiles.length };
}
