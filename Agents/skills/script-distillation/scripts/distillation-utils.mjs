import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const FORMULA_CATEGORIES = Object.freeze([
  "story_engine",
  "world_rule",
  "character_relationship",
  "long_arc",
  "episode_structure",
  "hook_information",
  "audience_payoff",
  "emotional_progression",
  "scene_conflict",
  "dialogue_action"
]);

export const CREATIVE_STAGES = Object.freeze([
  "global",
  "novel_analysis",
  "world_view",
  "outline_rewrite",
  "character_rewrite",
  "trial_generate",
  "full_generate",
  "dialogue_translate",
  "foreign_review"
]);

// 标签是短小且稳定的机器配置，直接随蒸馏工具提供默认值；调用方仍可
// 通过 --taxonomy 传入一份临时词表进行校验。
export const DEFAULT_TAXONOMY = Object.freeze({
  theme: Object.freeze([
    "现代言情", "女性成长", "脑洞", "奇幻", "玄幻", "古风言情", "战神", "宫斗", "仙侠", "权谋",
    "种田", "年代爱情", "悬疑", "喜剧", "志怪", "民国爱情", "灵异", "家国情怀", "法律", "刑侦",
    "抗战", "武侠", "民国传奇", "求生", "动作", "科幻", "恐怖", "商战"
  ]),
  setting: Object.freeze([
    "打脸虐渣", "大男主", "大女主", "马甲", "重生", "穿越", "系统", "先婚后爱", "家长里短", "小人物",
    "破镜重圆", "神豪", "豪门", "强者回归", "异能", "虐恋", "传承觉醒", "医生", "强强联合", "赘婿逆袭",
    "甜宠", "娱乐圈", "神医", "青梅竹马", "姐弟恋", "玄学", "追妻火葬场", "业界精英", "一见钟情", "福宝",
    "捞偏门", "反派主角", "萌宠", "双向救赎", "方言", "白月光", "灵魂互换", "病娇", "暴富", "黑道",
    "丧尸", "特种兵"
  ]),
  background: Object.freeze(["现代", "都市", "古代", "乡村", "年代", "架空", "职场", "民国", "校园", "宫廷", "荒岛"]),
  audience: Object.freeze(["男频", "女频"])
});
export const DEFAULT_TAXONOMY_PATH = "";

export function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\u0000/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
}

export function hashText(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export async function readJson(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`无法读取 JSON：${filePath}（${error.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 格式错误：${filePath}（${error.message}）`);
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function parseArgs(argv, allowed, required = []) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    if (!allowed[option] || index + 1 >= argv.length) {
      throw new Error(`参数错误：${option || "缺少参数"}`);
    }
    result[allowed[option]] = argv[index + 1];
  }
  for (const field of required) {
    if (!result[field]) throw new Error(`缺少参数：${field}`);
  }
  return result;
}

export function parseIndexedChunks(text) {
  const normalized = normalizeText(text);
  const marker = /^<!--\s*(C\d{4,})\s*\|\s*(.*?)\s*-->\s*$/gmu;
  const matches = [...normalized.matchAll(marker)];
  if (!matches.length) return [];
  return matches.map((match, index) => {
    const contentStart = Number(match.index) + match[0].length;
    const contentEnd = index + 1 < matches.length ? Number(matches[index + 1].index) : normalized.length;
    return {
      id: match[1],
      locator: match[2].trim() || `正文区块 ${index + 1}`,
      content: normalized.slice(contentStart, contentEnd).trim()
    };
  }).filter((item) => item.content);
}

function blockLocator(lines, ordinal) {
  const heading = lines.find((line) => /^(?:#{1,6}\s*)?第\s*[0-9一二三四五六七八九十百零〇]+\s*集/u.test(line.trim()));
  return heading ? heading.replace(/^#{1,6}\s*/u, "").trim() : `正文区块 ${ordinal}`;
}

export function chunkSource(text, maximumCharacters = 6000) {
  const lines = normalizeText(text).split("\n");
  const blocks = [];
  let current = [];
  let currentLength = 0;
  const flush = () => {
    if (!current.length) return;
    const content = current.join("\n").trim();
    if (content) blocks.push({ locator: blockLocator(current, blocks.length + 1), content });
    current = [];
    currentLength = 0;
  };
  for (const line of lines) {
    const addition = line.length + (current.length ? 1 : 0);
    if (current.length && currentLength + addition > maximumCharacters) flush();
    current.push(line);
    currentLength += addition;
  }
  flush();
  return blocks.map((item, index) => ({ ...item, id: `C${String(index + 1).padStart(4, "0")}` }));
}

export function indexedSourceText(chunks) {
  return `${chunks.map((item) => `<!-- ${item.id} | ${item.locator} -->\n${item.content}`).join("\n\n")}\n`;
}

export function sourceContentHash(chunks) {
  return hashText(chunks.map((item) => item.content).join("\n\n"));
}

export function guessTitle(text, fallback = "未命名剧本") {
  for (const rawLine of normalizeText(text).split("\n").slice(0, 30)) {
    const line = rawLine.replace(/^#{1,6}\s*/u, "").trim();
    if (!line || line.length > 80) continue;
    if (/^(?:<!--|第\s*[0-9一二三四五六七八九十百零〇]+\s*集|人物|梗概|正文|编剧)/u.test(line)) continue;
    return line.replace(/[《》]/gu, "").trim();
  }
  return fallback;
}

export function emptyDistillation({ title, contentHash, chunkCount }) {
  return {
    schema_version: "1.0.0",
    source: { title, content_sha256: contentHash, chunk_count: chunkCount },
    summary: "",
    tags: { theme: [], setting: [], background: [], audience: [] },
    case_card: {
      logline: "",
      audience_promise: "",
      story_engine: {
        initial_situation: "",
        protagonist_goal: "",
        main_resistance: "",
        stakes: "",
        repeatable_conflict_loop: "",
        ending_change: ""
      },
      world_rules: [],
      characters: [],
      relationship_dynamics: [],
      narrative_phases: [],
      audience_payoffs: [],
      key_observations: [],
      strengths: [],
      limitations: [],
      source_specific_terms: [],
      evidence_references: []
    },
    formula_candidates: [],
    no_formula_reason: "",
    principle_observations: [],
    no_principle_reason: "",
    quality_review: {
      full_source_read: false,
      facts_and_hypotheses_separated: false,
      formula_deidentified: false,
      principles_kept_as_candidates: false,
      known_unknowns: []
    }
  };
}

export async function loadTaxonomy(filePath = DEFAULT_TAXONOMY_PATH) {
  const taxonomy = filePath ? await readJson(path.resolve(filePath)) : DEFAULT_TAXONOMY;
  for (const key of ["theme", "setting", "background", "audience"]) {
    if (!Array.isArray(taxonomy[key]) || !taxonomy[key].length) throw new Error(`标签词表缺少 ${key}`);
  }
  return taxonomy;
}
