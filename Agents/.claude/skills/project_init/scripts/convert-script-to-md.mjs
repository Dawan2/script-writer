#!/usr/bin/env node
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SUPPORTED_TYPES = new Set(["pdf", "docx", "epub", "txt", "md", "markdown"]);
const { DOMParser } = require("@xmldom/xmldom");
const JSZip = require("jszip");

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--source" || argv[2] !== "--output") {
    throw new Error("请使用 --source <剧本路径> --output <输出路径>");
  }
  return { source: argv[1], output: argv[3] };
}

function normalizeMarkdown(title, value) {
  const text = String(value || "").replace(/\r\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  if (!text) throw new Error("转换后的剧本文本为空");
  const displayTitle = String(title || "原始剧本").replace(/[\r\n]+/gu, " ").trim() || "原始剧本";
  const heading = `# ${displayTitle}`;
  return /^#(?!#)[^\n]*(?=\n|$)/u.test(text)
    ? `${text.replace(/^#(?!#)[^\n]*(?=\n|$)/u, heading)}\n`
    : `${heading}\n\n${text}\n`;
}

function normalizedArchivePath(value) {
  return path.posix.normalize(String(value || "").replace(/\\/gu, "/")).replace(/^\.\//u, "");
}

function xmlDocument(value, label) {
  const document = new DOMParser().parseFromString(value, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error(`${label}格式无效`);
  return document;
}

function resolveArchivePath(baseFile, relativeFile) {
  return normalizedArchivePath(path.posix.join(path.posix.dirname(baseFile), relativeFile));
}

function textFromHtml(markup) {
  const document = new DOMParser().parseFromString(markup, "text/html");
  const hidden = new Set(["script", "style", "head", "title", "noscript"]);
  const block = new Set(["p", "div", "section", "article", "header", "footer", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr"]);
  const parts = [];
  function walk(node) {
    if (node.nodeType === 3) {
      parts.push(node.data || "");
      return;
    }
    if (node.nodeType !== 1) return;
    const name = String(node.nodeName || "").toLowerCase();
    if (hidden.has(name)) return;
    const separates = block.has(name);
    if (separates) parts.push("\n");
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
    if (separates) parts.push("\n");
  }
  const root = document.getElementsByTagName("body")[0] || document.documentElement;
  if (root) walk(root);
  return parts.join("").replace(/[ \t]+\n/gu, "\n").replace(/\n[ \t]+/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

async function epubToText(sourcePath) {
  const archive = await JSZip.loadAsync(await fs.readFile(sourcePath));
  const container = archive.file("META-INF/container.xml");
  if (!container) throw new Error("EPUB缺少 META-INF/container.xml");
  const containerDocument = xmlDocument(await container.async("string"), "EPUB容器信息");
  const rootfile = containerDocument.getElementsByTagName("rootfile")[0];
  const packagePath = normalizedArchivePath(rootfile?.getAttribute("full-path"));
  if (!packagePath) throw new Error("EPUB容器信息缺少内容清单路径");
  const packageFile = archive.file(packagePath);
  if (!packageFile) throw new Error("EPUB内容清单不存在");
  const packageDocument = xmlDocument(await packageFile.async("string"), "EPUB内容清单");
  const manifest = new Map();
  for (const item of Array.from(packageDocument.getElementsByTagName("item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, { href, mediaType: item.getAttribute("media-type") || "" });
  }
  const spine = Array.from(packageDocument.getElementsByTagName("itemref"))
    .map((item) => manifest.get(item.getAttribute("idref") || ""))
    .filter((item) => item && /(?:xhtml|html)/iu.test(item.mediaType || item.href));
  const chapters = spine.length
    ? spine.map((item) => resolveArchivePath(packagePath, item.href))
    : Object.keys(archive.files).filter((file) => /\.(?:xhtml?|html)$/iu.test(file)).sort();
  const pages = [];
  for (const chapterPath of chapters) {
    const chapter = archive.file(chapterPath);
    if (!chapter) continue;
    const text = textFromHtml(await chapter.async("string"));
    if (text) pages.push(text);
  }
  if (!pages.length) throw new Error("EPUB未找到可读取的正文内容");
  return pages.join("\n\n");
}

export async function convertScriptToMarkdown(source, output, { title = "" } = {}) {
  const sourcePath = path.resolve(source);
  const outputPath = path.resolve(output);
  const type = path.extname(sourcePath).slice(1).toLowerCase();
  if (!SUPPORTED_TYPES.has(type)) throw new Error("仅支持 pdf、docx、epub、txt、md 或 markdown 格式");
  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStat?.isFile()) throw new Error(`剧本文件不存在：${source}`);

  let text;
  let converter;
  const sourceTitle = path.basename(sourcePath, path.extname(sourcePath));
  if (["txt", "md", "markdown"].includes(type)) {
    text = await fs.readFile(sourcePath, "utf8");
    converter = `direct-${type}`;
  } else if (type === "docx") {
    const module = await import("mammoth");
    const mammoth = module.default || module;
    const result = await mammoth.convertToMarkdown({ path: sourcePath });
    text = result.value;
    converter = "mammoth";
  } else if (type === "epub") {
    text = await epubToText(sourcePath);
    converter = "epub-jszip";
  } else {
    const pdfParse = require("pdf-parse");
    const result = await pdfParse(await fs.readFile(sourcePath));
    text = result.text;
    converter = "pdf-parse";
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, normalizeMarkdown(title || sourceTitle, text), "utf8");
  return { output: outputPath, file_type: type, converter };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await convertScriptToMarkdown(args.source, args.output);
    process.stdout.write(`${JSON.stringify({ ok: true, message: "原始剧本已转换为 Markdown。", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, tool: "convert-script-to-md", message: error.message, next_action: "检查原剧本文件和格式后重试。" }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
