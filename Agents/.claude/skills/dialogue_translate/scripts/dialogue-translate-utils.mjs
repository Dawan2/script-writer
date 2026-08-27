import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dialogueTranslationHeading, dialogueTranslationRelativePath, fullScriptRelativePath } from "../../../tools/script-artifacts.mjs";

const STRUCTURAL_LABELS = new Set([
  "剧名", "标题", "集名", "人物", "场景", "时间", "地点", "动作", "镜头", "旁白", "说明", "备注", "本集梗概", "剧集梗概"
]);
export const PLACEHOLDER_PREFIX = "{{ORCA_DIALOGUE_TRANSLATION:";
export const MANIFEST_RELATIVE_PATH = "runtime/dialogue-translate/manifest.json";

export function hashText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function readOptionalJson(filePath) {
  return fs.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function dialogueMatch(line) {
  const source = String(line || "").replace(/\s+$/u, "");
  if (!source || /^[#△>|]/u.test(source.trimStart())) return null;
  const match = source.match(/^([^：:\n]{1,32}?)(?:[（(]([^）)\n]{1,24})[）)])?[：:]\s*(\S[\s\S]*)$/u);
  if (!match) return null;
  const speaker = match[1].trim();
  if (!speaker || STRUCTURAL_LABELS.has(speaker) || /^第\s*\d+\s*[集场]$/u.test(speaker)) return null;
  return { speaker, state: (match[2] || "").trim(), chinese: match[3].trim(), sourceLine: source };
}

function targetLine(line, mode) {
  const match = String(line || "").trim().match(/^[（(]([\s\S]+)[）)]$/u);
  if (!match) return "";
  const value = match[1].trim();
  if (mode === "existing-english") {
    // 原稿中的中文舞台提示也常用括号。只把明确的英文行当作旧译文，避免吞掉可拍动作。
    if (!/[A-Za-z]/u.test(value) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) return "";
  }
  return value;
}

function episodeNumber(line) {
  const match = String(line || "").match(/^#{1,6}\s*第\s*(\d+)\s*集(?:\s|$|[：:])/u)
    || String(line || "").match(/^#{1,6}\s*(?:EP|EPISODE)\s*[._ -]*(\d+)(?:\s|$)/iu);
  return match ? Number(match[1]) : null;
}

function episodeTitleMapFromOutline(outline) {
  const titles = new Map();
  outlineStages(outline).forEach((stage) => stage.episodes.forEach((episode) => {
    const number = episode?.["集数"];
    const title = typeof episode?.["剧集名称"] === "string" ? episode["剧集名称"].trim() : "";
    if (Number.isInteger(number) && number > 0 && title) titles.set(number, title);
  }));
  return titles;
}

export function extractEpisodeTitles(text) {
  const titles = new Map();
  for (const match of String(text || "").matchAll(/^#{1,6}[ \t]*第[ \t]*(\d+)[ \t]*集(?:[ \t]*[：:][ \t]*([^\r\n]*))?[ \t]*\r?$/gmu)) {
    const title = String(match[2] || "").trim();
    if (title) titles.set(Number(match[1]), title);
  }
  return titles;
}

export function normalizeEpisodeHeadingsForOutline(text, outline) {
  const titles = episodeTitleMapFromOutline(outline);
  if (!titles.size) return String(text || "");
  return String(text || "").replace(/^([#]{1,6})[ \t]*第[ \t]*(\d+)[ \t]*集(?:[ \t]*[：:][ \t]*[^\r\n]*)?[ \t]*\r?$/gmu, (heading, prefix, episode) => {
    const title = titles.get(Number(episode));
    return title ? `${prefix} 第${episode}集：${title}` : heading;
  });
}

export function extractDialogueSource(text, { existingTargetMode = "any" } = {}) {
  const lines = String(text || "").replace(/\r\n?/gu, "\n").split("\n");
  const output = [];
  const dialogues = [];
  const episodeSequences = new Map();
  let currentEpisode = null;
  let syntheticEpisode = 1;
  for (let index = 0; index < lines.length; index += 1) {
    const identifiedEpisode = episodeNumber(lines[index]);
    if (identifiedEpisode !== null) currentEpisode = identifiedEpisode;
    const dialogue = dialogueMatch(lines[index]);
    if (!dialogue) {
      output.push(lines[index]);
      continue;
    }
    const episode = currentEpisode ?? syntheticEpisode;
    const sequence = (episodeSequences.get(episode) || 0) + 1;
    episodeSequences.set(episode, sequence);
    const id = `E${String(episode).padStart(3, "0")}-L${String(sequence).padStart(4, "0")}`;
    const existingTarget = targetLine(lines[index + 1], existingTargetMode);
    dialogues.push({
      id,
      episode,
      line_number: index + 1,
      speaker: dialogue.speaker,
      state: dialogue.state,
      chinese: dialogue.chinese,
      existing_target: existingTarget
    });
    output.push(`${dialogue.sourceLine}  `, `（${PLACEHOLDER_PREFIX}${id}}}）`);
    if (existingTarget) index += 1;
  }
  return { dialogues, template: output.join("\n") };
}

function outlineStages(outline) {
  if (!isObject(outline)) return [];
  const opening = isObject(outline["开篇"]) ? outline["开篇"] : null;
  const units = Array.isArray(outline["剧情单元"]) ? outline["剧情单元"] : [];
  const raw = [];
  if (opening) raw.push({
    name: "开篇",
    description: String(opening["开篇描述"] || ""),
    key_roles: Array.isArray(opening["关键角色"]) ? opening["关键角色"] : [],
    episodes: Array.isArray(opening["剧集"]) ? opening["剧集"] : []
  });
  units.forEach((unit) => {
    if (!isObject(unit)) return;
    raw.push({
      name: String(unit["单元名称"] || "").trim(),
      description: String(unit["单元描述"] || ""),
      key_roles: Array.isArray(unit["关键角色"]) ? unit["关键角色"] : [],
      episodes: Array.isArray(unit["剧集"]) ? unit["剧集"] : []
    });
  });
  return raw.filter((unit) => unit.name && unit.episodes.length);
}

function standaloneUnits(dialogues) {
  const episodes = [...new Set(dialogues.map((item) => item.episode))].sort((left, right) => left - right);
  if (!episodes.length) return [];
  const units = [];
  for (let index = 0; index < episodes.length; index += 10) {
    const group = episodes.slice(index, index + 10);
    units.push({
      name: group.length === 1 ? `第${group[0]}集` : `第${group[0]}-${group.at(-1)}集`,
      description: "",
      key_roles: [],
      episodes: group.map((episode) => ({ "集数": episode, "关键角色": [] }))
    });
  }
  return units;
}

function currentStageCharacter(character, stageName) {
  const result = {};
  ["人物名称", "核心诉求", "人物难题", "关系与弧光"].forEach((field) => {
    if (typeof character?.[field] === "string" && character[field].trim()) result[field] = character[field].trim();
  });
  const changes = Array.isArray(character?.["阶段变化"]) ? character["阶段变化"] : [];
  result["阶段变化"] = changes.filter((item) => (
    isObject(item) && typeof item["故事阶段"] === "string" && item["故事阶段"].trim() === stageName
  ));
  return result;
}

function unitCharacters(unit, characters) {
  const names = new Set(unit.key_roles.filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim()));
  unit.episodes.forEach((episode) => {
    const roles = Array.isArray(episode?.["关键角色"]) ? episode["关键角色"] : [];
    roles.forEach((name) => {
      if (typeof name === "string" && name.trim()) names.add(name.trim());
    });
  });
  return characters.filter((character) => names.has(character?.["人物名称"]))
    .map((character) => currentStageCharacter(character, unit.name));
}

export function buildTranslationUnits({ dialogues, outline, characters, synopsis, worldView, regionRules, targetLocale, episodeTitles }) {
  const normalizedSynopsis = typeof synopsis === "string" ? synopsis.trim() : "";
  const stages = outlineStages(outline);
  const units = stages.length ? stages : standaloneUnits(dialogues);
  const titles = episodeTitles instanceof Map && episodeTitles.size
    ? episodeTitles
    : episodeTitleMapFromOutline(outline);
  const assigned = new Set();
  const payloads = [];
  units.forEach((unit, index) => {
    const episodeSet = new Set(unit.episodes.map((episode) => Number(episode?.["集数"])).filter(Number.isInteger));
    const selected = dialogues.filter((dialogue) => episodeSet.has(dialogue.episode));
    selected.forEach((dialogue) => assigned.add(dialogue.id));
    const episodeNumbers = [...new Set([
      ...selected.map((dialogue) => dialogue.episode),
      ...[...episodeSet].filter((episode) => titles.has(episode))
    ])].sort((left, right) => left - right);
    if (!episodeNumbers.length) return;
    payloads.push({
      unit_index: index + 1,
      unit_name: unit.name,
      unit_description: unit.description,
      characters: unitCharacters(unit, characters),
      dialogues: selected,
      episodes: episodeNumbers
    });
  });
  const unassigned = dialogues.filter((dialogue) => !assigned.has(dialogue.id));
  if (unassigned.length) {
    payloads.push({
      unit_index: payloads.length + 1,
      unit_name: "其他场次",
      unit_description: "",
      characters: [],
      dialogues: unassigned,
      episodes: [...new Set(unassigned.map((dialogue) => dialogue.episode))].sort((left, right) => left - right)
    });
  }
  return payloads.map((unit, index) => ({
    "schema_version": "1.0.0",
    "单元编号": index + 1,
    "剧情单元": unit.unit_name,
    "剧情单元描述": unit.unit_description,
    "故事梗概": normalizedSynopsis,
    "世界观": worldView,
    "目标语言": targetLocale,
    "地区规则": regionRules,
    "统一用语": (Array.isArray(outline?.["关键角色名称映射"]) ? outline["关键角色名称映射"] : []).flatMap((item) => {
      const source = typeof item?.["中文名称"] === "string" ? item["中文名称"].trim() : "";
      const target = typeof item?.["英文名称"] === "string" ? item["英文名称"].trim() : "";
      return source && target ? [{ "中文用语": source, "目标语用语": target, "说明": "角色名称" }] : [];
    }),
    "关键角色": unit.characters,
    ...(index === 0 && normalizedSynopsis ? { "英文简介": "" } : {}),
    "剧集": unit.episodes.map((episode) => {
      const title = titles.get(episode);
      return {
        "集数": episode,
        ...(title ? { "剧集名称": title, "目标语剧集名称": "" } : {}),
        "台词": unit.dialogues.filter((dialogue) => dialogue.episode === episode).map((dialogue) => ({
          "台词ID": dialogue.id,
          "人物": dialogue.speaker,
          "状态": dialogue.state,
          "中文台词": dialogue.chinese,
          "原目标语台词": dialogue.existing_target,
          "目标语台词": dialogue.existing_target
        }))
      };
    })
  }));
}

export function flattenTranslationLines(unit) {
  if (!isObject(unit) || !Array.isArray(unit["剧集"])) throw new Error("台词单元缺少剧集数组");
  return unit["剧集"].flatMap((episode) => {
    if (!isObject(episode) || !Number.isInteger(episode["集数"]) || !Array.isArray(episode["台词"])) {
      throw new Error("台词单元中的剧集结构无效");
    }
    return episode["台词"].map((line) => ({ ...line, episode: episode["集数"] }));
  });
}

function episodeTitleEntries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (!isObject(value)) return [];
  return Object.entries(value).map(([episode, title]) => [Number(episode), title]);
}

export function validateTranslationUnits(units, expectedDialogues, expectedEpisodeTitles = {}) {
  const expected = new Map(expectedDialogues.map((line) => [line.id, line]));
  const expectedTitles = new Map(episodeTitleEntries(expectedEpisodeTitles)
    .filter(([episode, title]) => Number.isInteger(episode) && episode > 0 && typeof title === "string" && title.trim())
    .map(([episode, title]) => [episode, title.trim()]));
  const translations = new Map();
  const episodeTitleTranslations = new Map();
  const issues = [];
  units.forEach(({ file, payload }) => {
    if (!isObject(payload) || payload.schema_version !== "1.0.0") {
      issues.push(`${file} 的 schema_version 必须为 1.0.0`);
      return;
    }
    if (typeof payload["故事梗概"] !== "string" || typeof payload["世界观"] !== "string") {
      issues.push(`${file} 的故事梗概和世界观必须是字符串`);
    }
    if (!Array.isArray(payload["关键角色"]) || !Array.isArray(payload["地区规则"]) || !Array.isArray(payload["统一用语"])) {
      issues.push(`${file} 的关键角色、地区规则和统一用语必须是数组`);
    }
    const episodes = Array.isArray(payload["剧集"]) ? payload["剧集"] : [];
    episodes.forEach((episode) => {
      const number = episode?.["集数"];
      const sourceTitle = expectedTitles.get(number);
      if (!sourceTitle) return;
      if (episode["剧集名称"] !== sourceTitle) {
        issues.push(`第${number}集的中文剧集名称被改动`);
      }
      const targetTitle = typeof episode["目标语剧集名称"] === "string" ? episode["目标语剧集名称"].trim() : "";
      if (!targetTitle) issues.push(`第${number}集缺少目标语剧集名称`);
      else if (/\r|\n/u.test(targetTitle)) issues.push(`第${number}集的目标语剧集名称不能换行`);
      else if (/[()（）]/u.test(targetTitle)) issues.push(`第${number}集的目标语剧集名称不需要包含括号`);
      if (episodeTitleTranslations.has(number)) issues.push(`第${number}集的目标语剧集名称重复`);
      episodeTitleTranslations.set(number, targetTitle);
    });
    let lines = [];
    try {
      lines = flattenTranslationLines(payload);
    } catch (error) {
      issues.push(`${file}：${error.message}`);
      return;
    }
    lines.forEach((line) => {
      const id = typeof line?.["台词ID"] === "string" ? line["台词ID"] : "";
      const source = expected.get(id);
      if (!source) {
        issues.push(`${file} 包含未知台词ID：${id || "空值"}`);
        return;
      }
      if (translations.has(id)) issues.push(`台词ID重复：${id}`);
      if (line["中文台词"] !== source.chinese || line["人物"] !== source.speaker || line.episode !== source.episode) {
        issues.push(`${id} 的中文台词、人物或集数被改动`);
      }
      const target = typeof line["目标语台词"] === "string" ? line["目标语台词"].trim() : "";
      if (!target) issues.push(`${id} 缺少目标语台词`);
      if (/\{\{ORCA_DIALOGUE_TRANSLATION:/u.test(target)) issues.push(`${id} 的目标语台词仍是占位符`);
      translations.set(id, target);
    });
  });
  expected.forEach((_line, id) => {
    if (!translations.has(id)) issues.push(`缺少台词ID：${id}`);
  });
  expectedTitles.forEach((_title, episode) => {
    if (!episodeTitleTranslations.has(episode)) issues.push(`第${episode}集缺少目标语剧集名称`);
  });
  return { issues: [...new Set(issues)], translations, episodeTitleTranslations };
}

export function validateSynopsisTranslation(units, storySynopsis) {
  if (!isObject(storySynopsis)) return { issues: [], translation: "" };
  const unitFile = typeof storySynopsis.unit_file === "string" ? storySynopsis.unit_file : "";
  const sourceHash = typeof storySynopsis.source_hash === "string" ? storySynopsis.source_hash : "";
  const issues = [];
  if (!unitFile || !sourceHash) return { issues: ["故事梗概翻译清单缺少来源信息"], translation: "" };
  const unit = units.find((item) => item.file === unitFile);
  if (!unit || !isObject(unit.payload)) {
    return { issues: [`故事梗概翻译单元不存在：${unitFile}`], translation: "" };
  }
  const source = typeof unit.payload["故事梗概"] === "string" ? unit.payload["故事梗概"].trim() : "";
  if (hashText(source) !== sourceHash) issues.push("故事梗概原文被改动");
  const translation = typeof unit.payload["英文简介"] === "string" ? unit.payload["英文简介"].trim() : "";
  if (!translation) issues.push("故事梗概缺少英文简介");
  return { issues, translation };
}

function renderEpisodeHeadingTranslations(text, episodeTitleTranslations) {
  if (!(episodeTitleTranslations instanceof Map) || !episodeTitleTranslations.size) return text;
  return text.replace(/^([#]{1,6})[ \t]*第[ \t]*(\d+)[ \t]*集(?:[ \t]*[：:][ \t]*([^\r\n]*))?[ \t]*\r?$/gmu, (source, prefix, episode, title) => {
    const targetTitle = episodeTitleTranslations.get(Number(episode));
    const chineseTitle = String(title || "").trim();
    if (!targetTitle || !chineseTitle) return source;
    return `${prefix} 第${episode}集：${chineseTitle}（${targetTitle}）`;
  });
}

export function renderTranslatedScript(template, translations, heading, episodeTitleTranslations = new Map()) {
  let output = String(template || "");
  for (const [id, target] of translations) {
    output = output.replace(`${PLACEHOLDER_PREFIX}${id}}}`, target);
  }
  output = renderEpisodeHeadingTranslations(output, episodeTitleTranslations);
  const lines = output.split("\n");
  const firstHeading = lines.findIndex((line) => /^#\s+/u.test(line));
  if (firstHeading >= 0 && episodeNumber(lines[firstHeading]) === null) lines[firstHeading] = heading;
  else lines.unshift(heading, "");
  return `${lines.join("\n").replace(/\s+$/u, "")}\n`;
}

function hasRenderedEpisodeHeading(text, episode, sourceTitle, targetTitle) {
  const heading = `第${episode}集：${sourceTitle}（${targetTitle}）`;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^#{1,6}[ \\t]+${escaped}[ \\t]*$`, "mu").test(text);
}

export function validateRenderedScript(text, expectedDialogues, expectedEpisodeTitles = {}, episodeTitleTranslations = new Map()) {
  const extracted = extractDialogueSource(text);
  const expected = new Map(expectedDialogues.map((line) => [line.id, line]));
  const expectedTitles = new Map(episodeTitleEntries(expectedEpisodeTitles)
    .filter(([episode, title]) => Number.isInteger(episode) && episode > 0 && typeof title === "string" && title.trim())
    .map(([episode, title]) => [episode, title.trim()]));
  const issues = [];
  if (extracted.dialogues.length !== expected.size) issues.push("台词译稿中的台词数量与中文母稿不一致");
  const seen = new Set();
  extracted.dialogues.forEach((line) => {
    const source = expected.get(line.id);
    if (!source) {
      issues.push(`台词译稿包含未知台词：${line.id}`);
      return;
    }
    if (seen.has(line.id)) issues.push(`台词译稿中的台词ID重复：${line.id}`);
    seen.add(line.id);
    if (line.speaker !== source.speaker || line.chinese !== source.chinese || line.episode !== source.episode) {
      issues.push(`${line.id} 的中文台词、人物或集数被改动`);
    }
    const target = line.existing_target.trim();
    if (!target) issues.push(`${line.id} 缺少目标语台词`);
    if (target.includes("{{ORCA_DIALOGUE_TRANSLATION:")) issues.push(`${line.id} 的目标语台词仍是占位符`);
  });
  expected.forEach((_line, id) => { if (!seen.has(id)) issues.push(`译稿缺少台词ID：${id}`); });
  expectedTitles.forEach((sourceTitle, episode) => {
    const targetTitle = episodeTitleTranslations.get(episode);
    if (targetTitle && !hasRenderedEpisodeHeading(text, episode, sourceTitle, targetTitle)) {
      issues.push(`第${episode}集的目标语剧集名称未写入台词译稿`);
    }
  });
  return [...new Set(issues)];
}

export function sourceAndOutputPaths(workspace, userInput, outline) {
  const project = isObject(userInput?.project) ? userInput.project : {};
  const taskType = typeof project.task_type === "string" ? project.task_type : "rewrite";
  const sourceRelativePath = taskType === "translate"
    ? (typeof project.source_script?.output_path === "string" ? project.source_script.output_path : "output/原始剧本.md")
    : fullScriptRelativePath(outline);
  const outputRelativePath = dialogueTranslationRelativePath(outline, userInput);
  return {
    taskType,
    sourceRelativePath,
    sourcePath: path.join(workspace, sourceRelativePath),
    outputRelativePath,
    outputPath: path.join(workspace, outputRelativePath),
    heading: dialogueTranslationHeading(outline, userInput)
  };
}

export async function readTranslationManifest(workspace) {
  const filePath = path.join(workspace, MANIFEST_RELATIVE_PATH);
  const manifest = await fs.readFile(filePath, "utf8").then(JSON.parse).catch(() => null);
  if (!isObject(manifest)) throw new Error("台词翻译清单不存在或格式无效");
  return manifest;
}

export async function readManifestUnits(workspace, manifest) {
  if (!Array.isArray(manifest.unit_files) || !manifest.unit_files.length) throw new Error("台词翻译清单缺少单元文件");
  return Promise.all(manifest.unit_files.map(async (file) => ({
    file,
    payload: JSON.parse(await fs.readFile(path.join(workspace, file), "utf8"))
  })));
}
