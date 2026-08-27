import crypto from "node:crypto";

export const TOP_LEVEL_KEYS = Object.freeze(["schema_version", "分析范围", "证据"]);
export const SCOPE_KEYS = Object.freeze(["名称", "时间范围"]);
export const EVIDENCE_KEYS = Object.freeze(["编号", "类型", "摘要", "项目", "来源", "指标"]);
export const EVIDENCE_TYPES = Object.freeze(["质量", "效率", "人工修改", "失败"]);
export const REQUIRED_HEADINGS = Object.freeze(["分析范围", "证据摘要", "候选改动", "不建议改动的事项", "人工评审"]);
export const CANDIDATE_FIELDS = Object.freeze(["证据", "调整对象", "具体改动", "质量验收", "效率验收", "回滚方式"]);

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function compactLength(value) {
  return String(value || "").replace(/\s/gu, "").length;
}

export function validateEvidence(evidence) {
  const issues = [];
  if (!hasExactKeys(evidence, TOP_LEVEL_KEYS)) return ["证据 JSON 顶层字段必须与 retrospective-evidence.json5 一致"];
  if (evidence.schema_version !== "1.0.0") issues.push("证据 JSON 的 schema_version 必须为 1.0.0");
  if (!hasExactKeys(evidence["分析范围"], SCOPE_KEYS)) {
    issues.push("分析范围字段必须与 retrospective-evidence.json5 一致");
  } else {
    ["名称", "时间范围"].forEach((field) => {
      if (!isText(evidence["分析范围"][field])) issues.push(`分析范围的${field}不能为空`);
    });
  }
  if (!Array.isArray(evidence["证据"])) return [...issues, "证据必须是数组"];
  const ids = new Set();
  evidence["证据"].forEach((item, index) => {
    const label = `第 ${index + 1} 条证据`;
    if (!hasExactKeys(item, EVIDENCE_KEYS)) {
      issues.push(`${label}字段必须与 retrospective-evidence.json5 一致`);
      return;
    }
    if (!isText(item["编号"])) issues.push(`${label}的编号不能为空`);
    else if (ids.has(item["编号"])) issues.push(`${label}的编号重复`);
    else ids.add(item["编号"]);
    if (!EVIDENCE_TYPES.includes(item["类型"])) issues.push(`${label}的类型必须为质量、效率、人工修改或失败`);
    if (!isText(item["摘要"])) issues.push(`${label}的摘要不能为空`);
    ["项目", "来源"].forEach((field) => {
      if (!Array.isArray(item[field]) || !item[field].every(isText)) issues.push(`${label}的${field}必须是非空字符串数组`);
    });
    if (!isObject(item["指标"])) issues.push(`${label}的指标必须是对象`);
  });
  return issues;
}

export function sections(text) {
  const lines = String(text || "").split(/\r?\n/u);
  const result = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^##\s+(.+?)\s*$/u)?.[1]?.trim();
    if (!heading || result.has(heading)) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^##\s+/u.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    result.set(heading, lines.slice(index + 1, end).join("\n").trim());
  }
  return result;
}

export function candidateBlocks(value) {
  const lines = String(value || "").split(/\r?\n/u);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^###\s+(.+?)\s*$/u)?.[1]?.trim();
    if (!heading) continue;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^###\s+/u.test(lines[cursor]) || /^##\s+/u.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    blocks.push({ heading, body: lines.slice(index + 1, end).join("\n").trim() });
  }
  return blocks;
}

export function labeledValue(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return String(text || "").match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${escaped}\\s*[:：]\\s*([^\\n]+)`, "u"))?.[1]?.trim() || "";
}

export function citations(text) {
  return [...String(text || "").matchAll(/\[([^\]\s]+)\]/gu)].map((match) => match[1]);
}

export function isSkillTarget(value) {
  return /Agents_new\/(?:\.claude\/(?:skills|tools)\/[^\s`]+\.(?:md|mjs|json5|json)|package\.json)\b/u.test(String(value || ""));
}

export function proposalSkeleton() {
  return `# Skill 改进提案\n\n## 分析范围\n\n## 证据摘要\n\n## 候选改动\n\n### 不建议本次修改\n- 判断：\n- 证据缺口：\n- 后续采集：\n\n## 不建议改动的事项\n\n## 人工评审\n- 评审状态：待人工评审\n`;
}

export function proposalAssessment(text, evidence) {
  const issues = [];
  const content = sections(text);
  REQUIRED_HEADINGS.forEach((heading) => {
    if (compactLength(content.get(heading)) < 12) issues.push(`提案章节“${heading}”缺少实质内容`);
  });
  const evidenceIds = new Set((evidence["证据"] || []).map((item) => item?.["编号"]));
  const cited = citations(text);
  const unknown = cited.filter((id) => !evidenceIds.has(id));
  if (unknown.length) issues.push(`提案引用了不存在的证据：${[...new Set(unknown)].join("、")}`);
  const candidates = candidateBlocks(content.get("候选改动"));
  if (!candidates.length) issues.push("候选改动必须包含候选项或不建议本次修改分支");
  const noChange = candidates.find((item) => item.heading === "不建议本次修改");
  if (noChange) {
    if (candidates.length !== 1) issues.push("不建议本次修改不能与候选改动混用");
    ["判断", "证据缺口", "后续采集"].forEach((field) => {
      if (compactLength(labeledValue(noChange.body, field)) < 8) issues.push(`不建议本次修改缺少${field}`);
    });
  } else {
    candidates.forEach((candidate) => {
      CANDIDATE_FIELDS.forEach((field) => {
        const minimum = field === "证据" ? 1 : 8;
        if (compactLength(labeledValue(candidate.body, field)) < minimum) issues.push(`候选改动“${candidate.heading}”缺少${field}`);
      });
      const candidateCitations = citations(candidate.body);
      if (!candidateCitations.some((id) => evidenceIds.has(id))) issues.push(`候选改动“${candidate.heading}”缺少真实证据编号`);
      if (!isSkillTarget(labeledValue(candidate.body, "调整对象"))) issues.push(`候选改动“${candidate.heading}”的调整对象必须位于 Agents_new Skill 或工具目录`);
    });
  }
  return { issues, citedIds: [...new Set(cited.filter((id) => evidenceIds.has(id)))], noChange: Boolean(noChange) };
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
