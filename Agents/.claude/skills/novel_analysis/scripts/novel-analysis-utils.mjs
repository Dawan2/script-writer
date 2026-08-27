import fs from "node:fs/promises";
import path from "node:path";
import { resolveTargetEpisodeCount } from "../../../tools/distribution-brief.mjs";
import { episodeDurationSeconds } from "../../../tools/screenplay-length.mjs";

export const ANALYSIS_RELATIVE_PATH = "2.1-novel-analysis.json";
export const INDEX_RELATIVE_PATH = "runtime/novel-source-index.json";
export const HIGHLIGHT_INDEX_RE = /^L(\d+)-L(\d+)$/u;
export const MAX_NOVEL_ANALYSIS_CHARACTERS = 600_000;
const EARLY_UNIT_COUNT = 3;
const EARLY_UNIT_MAX_EPISODES = 5;
const LATER_UNIT_MAX_EPISODES = 7;
const MAX_SOURCE_LINE_CHARS = 4000;
// A fact ledger records several causal dimensions for every retained event.
// Keep source batches below the ledger's reliable output capacity instead of
// filling the model's long-context window.
const TARGET_READING_BATCH_CHARS = 46_000;
const MIN_READING_BATCH_CHARS = 32_000;
const MAX_READING_BATCH_CHARS = 54_000;
const MAX_CHAPTERS_PER_READING_BATCH = 12;
const WHITESPACE_RE = /\s/u;

function splitLongSourceLine(line) {
  if (line.length <= MAX_SOURCE_LINE_CHARS) return [line];
  const parts = [];
  let remaining = line;
  const minimumBoundary = Math.floor(MAX_SOURCE_LINE_CHARS * 0.6);
  while (remaining.length > MAX_SOURCE_LINE_CHARS) {
    let splitAt = MAX_SOURCE_LINE_CHARS;
    for (let index = MAX_SOURCE_LINE_CHARS; index >= minimumBoundary; index -= 1) {
      if (/[\u3002！？；!?;]/u.test(remaining[index - 1])) {
        splitAt = index;
        break;
      }
    }
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  parts.push(remaining);
  return parts;
}

async function normalizeSourceLines(sourcePath, sourceText) {
  const originalLines = sourceText.split(/\r?\n/u);
  const normalizedLines = originalLines.flatMap(splitLongSourceLine);
  if (normalizedLines.length === originalLines.length) return { sourceText, lines: originalLines };
  const normalizedText = normalizedLines.join("\n");
  await fs.writeFile(sourcePath, normalizedText, "utf8");
  return { sourceText: normalizedText, lines: normalizedLines };
}

function renderedLineChars(line, lineNumber) {
  return String(lineNumber).length + 2 + line.length + 1;
}

function isDocumentMetadataLine(value) {
  return (
    !value
    || /^#{1,6}\s+\S/u.test(value)
    || /^(?:来源|來源|原文(?:链接|連結)?|作者|author|书名|書名|作品名|版权|版權)\s*[：:]/iu.test(value)
    || /^https?:\/\//iu.test(value)
    || /^(?:人物表|角色表|目录|目錄|内容简介|內容簡介|简介|簡介|文案|标签|標籤)$/u.test(value)
  );
}

function rangeChars(lines, startLine, endLine) {
  let total = 0;
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    total += renderedLineChars(lines[lineNumber - 1], lineNumber);
  }
  return total;
}

function splitOversizedRange(lines, startLine, endLine) {
  const ranges = [];
  let currentStart = startLine;
  let currentChars = 0;
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const lineChars = renderedLineChars(lines[lineNumber - 1], lineNumber);
    if (currentChars > 0 && currentChars + lineChars > TARGET_READING_BATCH_CHARS) {
      ranges.push({ start_line: currentStart, end_line: lineNumber - 1, char_count: currentChars });
      currentStart = lineNumber;
      currentChars = 0;
    }
    currentChars += lineChars;
  }
  if (currentStart <= endLine) {
    ranges.push({ start_line: currentStart, end_line: endLine, char_count: currentChars });
  }
  return ranges;
}

function buildReadingBatches(lines, chapters) {
  const batches = [];
  let startLine = 0;
  let endLine = 0;
  let chars = 0;
  let chapterCount = 0;

  const flush = () => {
    if (!startLine) return;
    batches.push({
      index: batches.length + 1,
      start_line: startLine,
      end_line: endLine,
      char_count: chars
    });
    startLine = 0;
    endLine = 0;
    chars = 0;
    chapterCount = 0;
  };

  for (const chapter of chapters) {
    const chapterChars = rangeChars(lines, chapter.start_line, chapter.end_line);
    if (chapterChars > MAX_READING_BATCH_CHARS) {
      flush();
      for (const range of splitOversizedRange(lines, chapter.start_line, chapter.end_line)) {
        batches.push({ index: batches.length + 1, ...range });
      }
      continue;
    }

    if (!startLine) {
      startLine = chapter.start_line;
      endLine = chapter.end_line;
      chars = chapterChars;
      chapterCount = 1;
      continue;
    }

    const mergedChars = chars + chapterChars;
    if (
      chapterCount >= MAX_CHAPTERS_PER_READING_BATCH
      ||
      mergedChars > MAX_READING_BATCH_CHARS
      || (chars >= MIN_READING_BATCH_CHARS && mergedChars > TARGET_READING_BATCH_CHARS)
    ) {
      flush();
      startLine = chapter.start_line;
      endLine = chapter.end_line;
      chars = chapterChars;
      chapterCount = 1;
      continue;
    }
    endLine = chapter.end_line;
    chars = mergedChars;
    chapterCount += 1;
  }
  flush();
  return batches;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolveWorkspaceFile(workspace, relativePath, label = "小说文件") {
  const workspaceRoot = path.resolve(workspace);
  const target = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label}必须位于当前项目目录内`);
  return target;
}

export async function readProjectFiles(workspace) {
  const [userInput, progress] = await Promise.all([
    fs.readFile(path.join(workspace, "1.1-user-input.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(workspace, "1.2-project-progress.json"), "utf8").then(JSON.parse)
  ]);
  return { userInput, progress };
}

export function novelSourceRelativePath(userInput) {
  const value = userInput?.project?.source_script?.output_path;
  if (typeof value !== "string" || !value.trim()) throw new Error("项目输入缺少小说内部文本路径");
  return value.trim();
}

export function countNovelCharacters(sourceText) {
  let characterCount = 0;
  for (const character of sourceText) {
    if (!WHITESPACE_RE.test(character)) characterCount += 1;
  }
  return characterCount;
}

export function novelAnalysisLengthLimitMessage(characterCount) {
  const wanCharacters = (characterCount / 10_000).toFixed(1);
  return `这是一部 ${wanCharacters} 万字的宏篇巨著，剧本化效果不会很好。\n建议分多季，每季30万字左右，再按季实现剧本化。`;
}

export class NovelAnalysisLengthLimitError extends Error {
  constructor(characterCount) {
    super(novelAnalysisLengthLimitMessage(characterCount));
    this.name = "NovelAnalysisLengthLimitError";
    this.characterCount = characterCount;
  }
}

export async function readNovelSourceStats(workspace, sourceRelativePath) {
  const sourcePath = resolveWorkspaceFile(workspace, sourceRelativePath, "小说内部文本");
  const sourceText = await fs.readFile(sourcePath, "utf8");
  if (!sourceText.trim()) throw new Error("小说内部文本不存在或为空");
  return {
    character_count: countNovelCharacters(sourceText),
    source_path: sourcePath
  };
}

export function assertNovelAnalysisLengthAllowed({ character_count: characterCount }) {
  if (characterCount > MAX_NOVEL_ANALYSIS_CHARACTERS) {
    throw new NovelAnalysisLengthLimitError(characterCount);
  }
}

export function deriveNovelOutlinePlan(project) {
  const brief = project?.distribution_brief;
  const targetEpisodeCount = resolveTargetEpisodeCount(brief);
  const episodeDuration = episodeDurationSeconds(brief?.episode_duration);
  const outlineUnitBudgets = [];
  let remainingEpisodes = targetEpisodeCount;

  while (remainingEpisodes > 0) {
    const outlineUnitOrder = outlineUnitBudgets.length + 1;
    const maxEpisodes = outlineUnitOrder <= EARLY_UNIT_COUNT
      ? EARLY_UNIT_MAX_EPISODES
      : LATER_UNIT_MAX_EPISODES;
    const plannedEpisodes = Math.min(remainingEpisodes, maxEpisodes);
    outlineUnitBudgets.push({
      outline_unit_order: outlineUnitOrder,
      max_episodes: maxEpisodes,
      planned_episodes: plannedEpisodes,
      planned_duration_seconds: plannedEpisodes * episodeDuration
    });
    remainingEpisodes -= plannedEpisodes;
  }

  return {
    target_episode_count: targetEpisodeCount,
    episode_duration_seconds: episodeDuration,
    target_total_duration_seconds: targetEpisodeCount * episodeDuration,
    max_outline_unit_count: outlineUnitBudgets.length,
    outline_unit_budgets: outlineUnitBudgets
  };
}

export async function buildNovelSourceIndex(workspace, sourceRelativePath) {
  const sourcePath = resolveWorkspaceFile(workspace, sourceRelativePath, "小说内部文本");
  const originalSourceText = await fs.readFile(sourcePath, "utf8");
  const { sourceText, lines } = await normalizeSourceLines(sourcePath, originalSourceText);
  if (!sourceText.trim()) throw new Error("小说内部文本不存在或为空");
  const chapterRe = /^\s{0,3}(?:#{1,6}\s*)?(?:第[零一二三四五六七八九十百千万两0-9]+[章节卷回部篇].*|(?:序章|楔子|引子|尾声|后记|番外)(?:[\s：:_-].*)?|(?:chapter|chap\.?|卷)[\s._-]*[0-9ivxlcdm]+\b.*)$/iu;
  const starts = [];
  lines.forEach((line, index) => {
    const value = line.trim();
    if (value && chapterRe.test(value)) starts.push({ title: value.replace(/^#{1,6}\s*/u, ""), start_line: index + 1 });
  });
  if (!starts.length) starts.push({ title: "全文", start_line: 1 });
  else if (starts[0].start_line > 1) {
    const prefaceLines = lines.slice(0, starts[0].start_line - 1);
    const hasPrefaceContent = prefaceLines.some((line) => !isDocumentMetadataLine(line.trim()));
    if (hasPrefaceContent) starts.unshift({ title: "开篇", start_line: 1 });
    else starts[0].start_line = 1;
  }
  const chapters = starts.map((chapter, index) => ({
    index: index + 1,
    title: chapter.title,
    start_line: chapter.start_line,
    end_line: (starts[index + 1]?.start_line ?? lines.length + 1) - 1
  }));
  const batches = buildReadingBatches(lines, chapters);
  const index = {
    schema_version: "1.1.0",
    source_file: sourceRelativePath,
    total_lines: lines.length,
    chapters,
    suggested_batches: batches
  };
  const indexPath = path.join(workspace, INDEX_RELATIVE_PATH);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}

export async function readNovelAnalysis(workspace) {
  return fs.readFile(path.join(workspace, ANALYSIS_RELATIVE_PATH), "utf8").then(JSON.parse);
}

export function sourceUnitsForReferences(analysis, references) {
  const wanted = new Set(Array.isArray(references) ? references.filter((value) => typeof value === "string") : []);
  const units = Array.isArray(analysis?.["剧情单元"]) ? analysis["剧情单元"] : [];
  return units.filter((unit) => wanted.has(unit?.["单元ID"])).map((unit) => ({
    unit_id: unit["单元ID"],
    unit_name: unit["单元名称"],
    highlights: Array.isArray(unit["高光时刻"])
      ? unit["高光时刻"].map((item) => ({ name: item?.["名称"], source_index: item?.["原文索引"] }))
      : []
  }));
}
