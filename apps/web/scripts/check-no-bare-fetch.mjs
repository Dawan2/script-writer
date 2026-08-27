#!/usr/bin/env node
// 静态检查：除登记过的网络出口外，前端代码不得直接调用 fetch。
// 允许清单见同目录 allowed-network-egress.json。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const srcRoot = join(appRoot, "src");
const configPath = join(scriptDir, "allowed-network-egress.json");

const SCANNED_EXTENSIONS = [".ts", ".tsx"];

/** 把注释与字符串字面量替换为空白，保留行列位置，避免把文案里的 fetch 当成调用。 */
export function stripCommentsAndStrings(source) {
  const out = new Array(source.length);
  const blank = (index) => {
    out[index] = source[index] === "\n" ? "\n" : " ";
  };

  let state = "code";
  let templateDepth = 0;
  const braceStack = [];

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "lineComment";
        blank(i);
        continue;
      }
      if (char === "/" && next === "*") {
        state = "blockComment";
        blank(i);
        continue;
      }
      if (char === "'" || char === '"') {
        state = char === "'" ? "single" : "double";
        blank(i);
        continue;
      }
      if (char === "`") {
        state = "template";
        templateDepth += 1;
        blank(i);
        continue;
      }
      if (char === "}" && braceStack.length && braceStack[braceStack.length - 1] === "template") {
        braceStack.pop();
        state = "template";
        blank(i);
        continue;
      }
      if (char === "{" && braceStack.length) braceStack.push("code");
      else if (char === "}" && braceStack.length) braceStack.pop();
      out[i] = char;
      continue;
    }

    if (state === "lineComment") {
      if (char === "\n") state = "code";
      blank(i);
      continue;
    }

    if (state === "blockComment") {
      if (char === "*" && next === "/") {
        blank(i);
        i += 1;
        blank(i);
        state = "code";
        continue;
      }
      blank(i);
      continue;
    }

    if (state === "single" || state === "double") {
      if (char === "\\") {
        blank(i);
        i += 1;
        if (i < source.length) blank(i);
        continue;
      }
      if ((state === "single" && char === "'") || (state === "double" && char === '"')) state = "code";
      blank(i);
      continue;
    }

    // state === "template"
    if (char === "\\") {
      blank(i);
      i += 1;
      if (i < source.length) blank(i);
      continue;
    }
    if (char === "$" && next === "{") {
      blank(i);
      i += 1;
      blank(i);
      braceStack.push("template");
      state = "code";
      continue;
    }
    if (char === "`") {
      templateDepth -= 1;
      state = "code";
      blank(i);
      continue;
    }
    blank(i);
  }

  return out.join("");
}

const BARE_FETCH = /(?<![.\w$])fetch\s*\(/g;
const GLOBAL_FETCH = /\b(?:window|globalThis|self|global)\s*\.\s*fetch\s*\(/g;

/** 找出一份源码里的裸 fetch 调用，返回 { line, column, text } 列表。 */
export function findBareFetch(source) {
  const stripped = stripCommentsAndStrings(source);
  const lines = source.split("\n");
  const lineStarts = [];
  let cursor = 0;
  for (const line of lines) {
    lineStarts.push(cursor);
    cursor += line.length + 1;
  }
  const locate = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: index - lineStarts[low] + 1, text: lines[low].trim() };
  };

  const hits = [];
  for (const pattern of [BARE_FETCH, GLOBAL_FETCH]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(stripped)) !== null) hits.push(locate(match.index));
  }
  return hits.sort((a, b) => a.line - b.line || a.column - b.column);
}

function loadAllowList() {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const files = new Set((config["文件"] ?? []).map((item) => normalize(item["路径"])));
  const patterns = (config["目录规则"] ?? []).map((item) => globToRegExp(normalize(item["匹配"])));
  return { files, patterns };
}

function normalize(value) {
  return String(value).split(sep).join("/");
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped
    .split("**/")
    .map((part) => part.split("*").join("[^/]*"))
    .join("(?:.*/)?");
  return new RegExp(`^${source}$`);
}

function isAllowed(relativePath, allowList) {
  if (allowList.files.has(relativePath)) return true;
  return allowList.patterns.some((pattern) => pattern.test(relativePath));
}

function collectSourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) found.push(full);
  }
  return found;
}

function main(argv) {
  const allowList = loadAllowList();
  const explicit = argv.filter((arg) => !arg.startsWith("-"));
  const files = explicit.length
    ? explicit.map((arg) => resolve(process.cwd(), arg))
    : collectSourceFiles(srcRoot);

  const violations = [];
  for (const file of files) {
    if (!statSync(file).isFile()) continue;
    const relativePath = normalize(relative(appRoot, file));
    if (!explicit.length && isAllowed(relativePath, allowList)) continue;
    for (const hit of findBareFetch(readFileSync(file, "utf8"))) {
      violations.push({ relativePath, ...hit });
    }
  }

  if (violations.length) {
    console.error(`检查未通过：${violations.length} 处代码直接调用了 fetch。`);
    console.error("前端请求必须走已登记的网络出口，才能统一超时、重试、错误解析与离线门控。");
    for (const violation of violations) {
      console.error(`  ${violation.relativePath}:${violation.line}:${violation.column}  ${violation.text}`);
    }
    console.error(`若确实需要新增网络出口，请在 ${normalize(relative(appRoot, configPath))} 登记并写明理由。`);
    return 1;
  }

  console.log(`检查通过：${files.length} 个文件中没有绕过网络出口的 fetch 调用。`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
