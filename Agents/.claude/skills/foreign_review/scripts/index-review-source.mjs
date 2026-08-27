#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hashFile, hashText, normalizeLines, resolveReviewInput, writeJson } from "./foreign-review-utils.mjs";

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") throw new Error("请使用 --workspace <项目目录>");
  return { workspace: path.resolve(argv[1]) };
}

function structuralText(line) {
  return String(line)
    .replace(/\\([#_`*\\-])/gu, "$1")
    .replace(/^\s*(?:#{1,6}|>+|[-+*])\s*/u, "")
    .replace(/(?:__|\*\*|~~|`)/gu, "")
    .trim();
}

function episodeNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (Object.hasOwn(digits, character)) current = digits[character];
    else if (Object.hasOwn(units, character)) {
      total += (current || 1) * units[character];
      current = 0;
    } else return Number.NaN;
  }
  return total + current;
}

function episodeMarker(line) {
  const title = structuralText(line);
  const match = title.match(/^(?:第\s*([0-9一二三四五六七八九十百零〇]{1,5})\s*(?:集|话|篇)|(?:episode|ep\.?)\s*(\d{1,3})|e\s*(\d{1,3}))(?:\s+|$|[：:、-])/iu);
  const number = episodeNumber(match?.[1] || match?.[2] || match?.[3] || "");
  return Number.isInteger(number) && number > 0 ? { number, title, raw_title: String(line).trim() } : null;
}

function sceneMarker(line) {
  const title = structuralText(line);
  const match = title.match(/^(?:场|scene)\s*(\d+)\s*[-—]\s*(\d+)(?:\s+|$|[：:、-])/iu);
  if (match) {
    return {
      title,
      raw_title: String(line).trim(),
      episode: Number(match[1]),
      scene: Number(match[2])
    };
  }
  return /^(?:场\s*\d+|场景\s*\d+|scene\s+\d+)/iu.test(title)
    ? { title, raw_title: String(line).trim(), episode: null, scene: null }
    : null;
}

function scriptMetrics(lines) {
  const dialogue = lines.map((line) => line.match(/^[^#△【\s][^：:]{0,48}[：:]\s*(.+)$/u)).filter(Boolean);
  return {
    total_lines: lines.length,
    non_empty_lines: lines.filter((line) => line.trim()).length,
    characters: lines.join("\n").replace(/\s/gu, "").length,
    dialogue_lines: dialogue.length,
    dialogue_characters: dialogue.reduce((total, match) => total + match[1].replace(/\s/gu, "").length, 0),
    narration_lines: lines.filter((line) => /^\s*【.+】\s*$/u.test(line)).length,
    action_lines: lines.filter((line) => /^\s*[△▲]/u.test(line)).length,
    scene_markers: lines.filter(sceneMarker).length
  };
}

function blockUnits(lines, start = 1, end = lines.length) {
  const units = [];
  let cursor = start;
  let ordinal = 1;
  while (cursor <= end) {
    let blockEnd = Math.min(cursor + 159, end);
    for (let line = blockEnd; line > cursor + 40; line -= 1) {
      if (!lines[line - 1]?.trim()) {
        blockEnd = line;
        break;
      }
    }
    units.push({ id: `block-${ordinal}`, type: "正文区块", start_line: cursor, end_line: blockEnd, label: `正文第 ${cursor}-${blockEnd} 行` });
    cursor = blockEnd + 1;
    ordinal += 1;
  }
  return units;
}

function unitsFromMarkers(markers, lines, { type, prefix }) {
  const units = [];
  if (markers[0].line > 1) units.push({ id: "front-matter", type: "前置信息", start_line: 1, end_line: markers[0].line - 1, label: "前置信息" });
  markers.forEach((marker, index) => {
    const endLine = index + 1 < markers.length ? markers[index + 1].line - 1 : lines.length;
    units.push({
      id: `${prefix}-${marker.number || index + 1}`,
      type,
      ...(marker.number ? { episode: marker.number } : {}),
      title: marker.title,
      start_line: marker.line,
      end_line: endLine,
      label: marker.number ? (type === "剧集" ? `第 ${marker.number} 集` : `${type}第 ${marker.number} 集`) : `${type}${index + 1}`
    });
  });
  return units;
}

function continuousEpisodes(markers) {
  return markers.length >= 2
    && markers[0].number === 1
    && markers.every((item, index) => index === 0 || item.number === markers[index - 1].number + 1);
}

function episodesFromSceneMarkers(sceneMarkers) {
  if (!sceneMarkers.length || sceneMarkers.some((item) => !Number.isInteger(item.episode) || !Number.isInteger(item.scene))) return [];
  const episodes = [];
  let activeEpisode = null;
  let previousScene = 0;
  for (const marker of sceneMarkers) {
    if (marker.episode !== activeEpisode) {
      if (activeEpisode !== null && marker.episode !== activeEpisode + 1) return [];
      if (marker.scene !== 1) return [];
      episodes.push({
        number: marker.episode,
        title: `第 ${marker.episode} 集`,
        raw_title: marker.raw_title,
        line: marker.line
      });
      activeEpisode = marker.episode;
      previousScene = marker.scene;
      continue;
    }
    if (marker.scene !== previousScene + 1) return [];
    previousScene = marker.scene;
  }
  return continuousEpisodes(episodes) ? episodes : [];
}

export async function buildReviewSourceIndex(workspace) {
  const input = await resolveReviewInput(workspace);
  const text = await fs.readFile(input.scriptPath, "utf8");
  const lines = normalizeLines(text);
  if (!lines.join("\n").trim()) throw new Error("待审剧本文本为空");

  const markers = lines.flatMap((line, index) => {
    const marker = episodeMarker(line);
    return marker ? [{ ...marker, line: index + 1 }] : [];
  });
  const sceneMarkers = lines.flatMap((line, index) => {
    const marker = sceneMarker(line);
    return marker ? [{ ...marker, line: index + 1 }] : [];
  });
  const sceneEpisodes = episodesFromSceneMarkers(sceneMarkers.filter((marker) => Number.isInteger(marker.episode) && Number.isInteger(marker.scene)));
  const formalMarkers = continuousEpisodes(markers) ? markers : sceneEpisodes;
  const structure = formalMarkers.length ? "规范分集" : markers.length || sceneMarkers.length ? "候选结构" : "无规范结构";
  const units = [];
  if (structure === "规范分集") units.push(...unitsFromMarkers(formalMarkers, lines, { type: "剧集", prefix: "episode" }));
  else if (markers.length) units.push(...unitsFromMarkers(markers, lines, { type: "候选剧集", prefix: "candidate-episode" }));
  else if (sceneMarkers.length) units.push(...unitsFromMarkers(sceneMarkers, lines, { type: "场次", prefix: "scene" }));
  else units.push(...blockUnits(lines));

  units.forEach((unit) => {
    unit.mechanical_stats = scriptMetrics(lines.slice(unit.start_line - 1, unit.end_line));
  });
  const sourcePath = input.sourcePath && (await fs.stat(input.sourcePath).catch(() => null))?.isFile() ? input.sourcePath : "";
  const index = {
    schema_version: "1.0.0",
    script_path: input.scriptRelativePath,
    script_hash: hashText(text),
    source_path: input.sourceRelativePath || sourcePath,
    source_hash: sourcePath ? await hashFile(sourcePath) : "",
    structure_status: structure,
    structure_note: structure === "规范分集"
      ? sceneEpisodes.length && !continuousEpisodes(markers)
        ? "已按连续“场<集号>-<场号>”标记归并正式剧集。"
        : "已识别从第 1 集开始连续编号的正式集标题。"
      : structure === "候选结构"
        ? "发现疑似分集或场次标记，但格式、顺序或完整性不足以作为正式集数。"
        : "未识别稳定的集标题；审读台账按正文区块建立。",
    markers,
    units,
    stats: {
      ...scriptMetrics(lines),
      episode_markers: markers.length,
      scene_markers: sceneMarkers.length,
      scene_episode_markers: sceneEpisodes.length
    }
  };
  await writeJson(path.join(workspace, "runtime", "review-source-index.json"), index);
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildReviewSourceIndex(parseArgs(process.argv.slice(2)).workspace)
    .then((index) => process.stdout.write(`${JSON.stringify({ ok: true, message: "审读索引已建立。", structure_status: index.structure_status, units: index.units.length, next_action: "根据索引全文审读正文，并记录审读覆盖。" }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, tool: "建立审读索引", message: error.message, next_action: "检查剧本文本是否可读，并提供规范文本或可识别的分集信息。" }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
