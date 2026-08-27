import path from "node:path";
import { fullScriptHeading } from "../../../tools/script-artifacts.mjs";

export function collectOutlineStages(outline) {
  if (!outline || typeof outline !== "object" || Array.isArray(outline) || !Array.isArray(outline["剧情单元"])) {
    throw new Error("3.1-outline.json 缺少剧情单元");
  }
  const opening = outline["开篇"];
  if (!opening || typeof opening !== "object" || Array.isArray(opening) || !Array.isArray(opening["剧集"])) {
    throw new Error("3.1-outline.json 缺少开篇");
  }
  const rawStages = [{
    name: "开篇",
    description: opening["开篇描述"],
    key_roles: Array.isArray(opening["关键角色"]) ? opening["关键角色"] : [],
    source_unit_ids: Array.isArray(opening["原著剧情单元"]) ? opening["原著剧情单元"] : [],
    episodes: opening["剧集"]
  }, ...outline["剧情单元"].map((unit) => ({
    name: unit?.["单元名称"],
    description: unit?.["单元描述"],
    key_roles: Array.isArray(unit?.["关键角色"]) ? unit["关键角色"] : [],
    source_unit_ids: Array.isArray(unit?.["原著剧情单元"]) ? unit["原著剧情单元"] : [],
    episodes: unit?.["剧集"]
  }))];
  let expectedEpisode = 1;
  return rawStages.map((stage, stageIndex) => {
    if (typeof stage.name !== "string" || !stage.name.trim() || !Array.isArray(stage.episodes)) {
      throw new Error(`第 ${stageIndex + 1} 个故事阶段结构无效`);
    }
    const episodes = stage.episodes.map((episode) => {
      if (!Number.isInteger(episode?.["集数"]) || episode["集数"] !== expectedEpisode) {
        throw new Error(`3.1-outline.json 的剧集必须从 1 连续编号；第 ${expectedEpisode} 集无效`);
      }
      expectedEpisode += 1;
      return episode;
    });
    return { ...stage, name: stage.name.trim(), stage_index: stageIndex, episodes };
  });
}

export function flattenEpisodes(stages) {
  return stages.flatMap((stage) => stage.episodes.map((episode) => ({
    episode: episode["集数"],
    episode_title: episodeTitle(episode),
    stage_name: stage.name,
    stage_description: stage.description,
    stage_roles: stage.key_roles,
    episode_info: episode
  })));
}

export function trialEpisodeCount(stages) {
  return Math.min(10, flattenEpisodes(stages).length);
}

export function getStageTasks(stages, covered = trialEpisodeCount(stages)) {
  return stages.map((stage) => ({ ...stage, episodes: stage.episodes.filter((episode) => episode["集数"] > covered) }))
    .filter((stage) => stage.episodes.length);
}

function safeFilePart(value) {
  return String(value || "").trim().replace(/\s+/gu, "-")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "-").slice(0, 80) || "未命名单元";
}

export function stageDirectory(workspace) {
  return path.join(workspace, "tmp", "全稿分阶段");
}

export function stageFilePath(workspace, stage) {
  return path.join(stageDirectory(workspace), `${String(stage.stage_index + 1).padStart(2, "0")}-${safeFilePart(stage.name)}.md`);
}

function episodeNumber(entry) {
  const number = Number.isInteger(entry?.episode) ? entry.episode : entry?.["集数"];
  if (!Number.isInteger(number) || number < 1) throw new Error("剧集缺少有效集数");
  return number;
}

export function episodeTitle(entry) {
  const title = typeof entry?.episode_title === "string"
    ? entry.episode_title.trim()
    : typeof entry?.episode_info?.["剧集名称"] === "string"
      ? entry.episode_info["剧集名称"].trim()
      : typeof entry?.["剧集名称"] === "string"
        ? entry["剧集名称"].trim()
        : "";
  if (!title) throw new Error(`3.1-outline.json 的第 ${episodeNumber(entry)} 集缺少剧集名称`);
  return title;
}

export function episodeHeading(entry) {
  return `## 第${episodeNumber(entry)}集：${episodeTitle(entry)}`;
}

export function renderStageScaffold(stage) {
  return `# ${stage.name}\n\n${stage.episodes.map((episode) => episodeHeading(episode)).join("\n\n")}\n`;
}

export function extractEpisodeSections(text) {
  const headings = [...String(text || "").matchAll(/^##[ \t]*第[ \t]*(\d+)[ \t]*集(?:[ \t]*[：:][ \t]*(.+?))?[ \t]*\r?$/gmu)];
  return headings.map((heading, index) => ({
    episode: Number(heading[1]),
    title: (heading[2] || "").trim(),
    markdown: String(text).slice(heading.index, headings[index + 1]?.index).trim(),
    content: String(text).slice(heading.index + heading[0].length, headings[index + 1]?.index).trim()
  }));
}

export function assertEpisodeNumbers(sections, expectedEntries, label) {
  const actual = sections.map((section) => section.episode);
  const expected = expectedEntries.map((entry) => entry.episode ?? entry["集数"]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}必须且只能包含第 ${expected.join("、")} 集`);
  }
}

export function normalizeEpisodeSectionHeading(section, entry) {
  const markdown = String(section?.markdown || "");
  if (!markdown) return episodeHeading(entry);
  return markdown.replace(/^##[ \t]*第[ \t]*\d+[ \t]*集(?:[ \t]*[：:][ \t]*[^\r\n]*)?[ \t]*\r?$/mu, episodeHeading(entry));
}

export function renderFullScript(sections, outline) {
  const entries = new Map(flattenEpisodes(collectOutlineStages(outline)).map((entry) => [entry.episode, entry]));
  const normalized = sections.map((section) => {
    const entry = entries.get(section.episode);
    if (!entry) throw new Error(`剧本全稿包含大纲外的第 ${section.episode} 集`);
    return normalizeEpisodeSectionHeading(section, entry);
  });
  return `${fullScriptHeading(outline)}\n\n${normalized.join("\n\n")}\n`;
}

export function roleNames(stage) {
  const names = new Set(stage.key_roles || []);
  stage.episodes.forEach((episode) => (episode["关键角色"] || []).forEach((name) => names.add(name)));
  return names;
}
