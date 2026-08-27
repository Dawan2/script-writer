#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_TAXONOMY_PATH,
  chunkSource,
  emptyDistillation,
  guessTitle,
  indexedSourceText,
  loadTaxonomy,
  normalizeText,
  parseArgs,
  parseIndexedChunks,
  readJson,
  sourceContentHash,
  writeJson
} from "./distillation-utils.mjs";

const OPTIONS = Object.freeze({
  "--source": "source",
  "--output": "output",
  "--title": "title",
  "--taxonomy": "taxonomy"
});

export async function initializeDistillation(args) {
  const sourcePath = path.resolve(args.source);
  const outputPath = path.resolve(args.output);
  const taxonomyPath = args.taxonomy ? path.resolve(args.taxonomy) : DEFAULT_TAXONOMY_PATH;
  const sourceText = normalizeText(await fs.readFile(sourcePath, "utf8"));
  if (sourceText.replace(/\s/gu, "").length < 200) throw new Error("剧本文本过短，无法进行可靠蒸馏");
  await loadTaxonomy(taxonomyPath);

  let chunks = parseIndexedChunks(sourceText);
  if (!chunks.length) chunks = chunkSource(sourceText);
  if (!chunks.length) throw new Error("剧本文本没有可读取的正文");

  const indexedPath = path.resolve(path.dirname(outputPath), "indexed-source.md");
  if (indexedPath !== sourcePath || !parseIndexedChunks(sourceText).length) {
    await fs.mkdir(path.dirname(indexedPath), { recursive: true });
    await fs.writeFile(indexedPath, indexedSourceText(chunks), "utf8");
  }

  const current = await readJson(outputPath).catch(() => null);
  const hasContent = current && (
    String(current.summary || "").trim()
    || (Array.isArray(current.formula_candidates) && current.formula_candidates.length)
    || (Array.isArray(current.case_card?.key_observations) && current.case_card.key_observations.length)
  );
  if (hasContent) throw new Error("结果文件已有蒸馏内容，请使用新的输出路径，避免覆盖既有结论");

  const title = String(args.title || "").trim() || guessTitle(chunks[0].content, path.basename(sourcePath, path.extname(sourcePath)));
  await writeJson(outputPath, emptyDistillation({
    title,
    contentHash: sourceContentHash(chunks),
    chunkCount: chunks.length
  }));
  return {
    indexed_source: indexedPath,
    output: outputPath,
    taxonomy: taxonomyPath || "内置标签词表",
    title,
    chunk_count: chunks.length,
    first_evidence: chunks[0].id,
    last_evidence: chunks.at(-1).id
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  initializeDistillation(parseArgs(process.argv.slice(2), OPTIONS, ["source", "output"]))
    .then((result) => process.stdout.write(`${JSON.stringify({
      ok: true,
      message: "单剧蒸馏已初始化。",
      next_action: "从 start=1 开始连续调用分段读取蒸馏原文，直到 completed=true。",
      ...result
    }, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        tool: "初始化单剧蒸馏",
        message: error.message,
        next_action: "检查文本原文、标签词表和输出路径后重试。"
      }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
