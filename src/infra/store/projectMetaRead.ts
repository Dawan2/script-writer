/**
 * 基础设施·project.yaml 读侧（W1-P1-T08 `sw doctor` 的最小实现）。
 *
 * 解析范围 = `serializeProjectMeta` 产出的 YAML 1.2 子集：顶层与两空格缩进两级、
 * JSON 双引号标量、inline map（`{ k: v }`）与 inline array（`[ ... ]`），
 * 另容忍空行与整行注释。超出子集的写法一律返回结构化解析失败（含行号），
 * 由诊断层转为红项，不抛裸异常。
 *
 * TODO(W1-P1-T05)：引擎的严格解析/校验器落地后可替换本模块（如引入 YAML 依赖），
 * 诊断层只消费 `RawMap` 结构，不受实现替换影响。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_FILE } from './layout.js';

export type RawValue = string | number | boolean | null | RawValue[] | RawMap;

export interface RawMap {
  [key: string]: RawValue;
}

export type ParseOutcome = { ok: true; raw: RawMap } | { ok: false; reason: string };

type ValueOutcome = { ok: true; value: RawValue } | { ok: false; reason: string };

/** 顶层逗号切分（尊重双引号字符串与嵌套 {}/[]，供 inline map/array 使用）。 */
function splitTopLevel(text: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
      current += ch;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (inString || depth !== 0) {
    return null;
  }
  parts.push(current);
  return parts;
}

function parseScalar(text: string): ValueOutcome {
  if (text.startsWith('"')) {
    try {
      return { ok: true, value: JSON.parse(text) as string };
    } catch {
      return { ok: false, reason: `字符串标量非法：${text}` };
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return { ok: true, value: Number(text) };
  }
  if (text === 'true' || text === 'false') {
    return { ok: true, value: text === 'true' };
  }
  if (text === 'null' || text === '~') {
    return { ok: true, value: null };
  }
  // 裸标量（如 short-video、markdown、2026-08-27）按字符串处理
  return { ok: true, value: text };
}

function parseValue(text: string): ValueOutcome {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    if (!trimmed.endsWith('}')) {
      return { ok: false, reason: `inline map 未闭合：${trimmed}` };
    }
    const body = trimmed.slice(1, -1).trim();
    const map: RawMap = {};
    if (body === '') {
      return { ok: true, value: map };
    }
    const entries = splitTopLevel(body);
    if (entries === null) {
      return { ok: false, reason: `inline map 括号/引号不配对：${trimmed}` };
    }
    for (const entry of entries) {
      const match = /^([A-Za-z_][\w-]*):(.+)$/.exec(entry.trim());
      if (!match) {
        return { ok: false, reason: `inline map 条目无法识别：${entry.trim()}` };
      }
      const parsed = parseValue(match[2] ?? '');
      if (!parsed.ok) {
        return parsed;
      }
      map[match[1] ?? ''] = parsed.value;
    }
    return { ok: true, value: map };
  }
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) {
      return { ok: false, reason: `inline array 未闭合：${trimmed}` };
    }
    const body = trimmed.slice(1, -1).trim();
    if (body === '') {
      return { ok: true, value: [] };
    }
    const items = splitTopLevel(body);
    if (items === null) {
      return { ok: false, reason: `inline array 括号/引号不配对：${trimmed}` };
    }
    const values: RawValue[] = [];
    for (const item of items) {
      const parsed = parseValue(item.trim());
      if (!parsed.ok) {
        return parsed;
      }
      values.push(parsed.value);
    }
    return { ok: true, value: values };
  }
  return parseScalar(trimmed);
}

/** project.yaml 文本 → 原始结构（宽松子集解析；字段级校验属诊断/引擎层）。 */
export function parseProjectMetaText(text: string): ParseOutcome {
  const raw: RawMap = {};
  let section: RawMap | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const match = /^( *)([A-Za-z_][\w-]*): ?(.*)$/.exec(line);
    if (!match) {
      return { ok: false, reason: `第 ${lineNo} 行无法识别：${line.trim()}` };
    }
    const indent = (match[1] ?? '').length;
    const key = match[2] ?? '';
    const rest = (match[3] ?? '').trim();
    if (indent === 0) {
      if (rest === '') {
        section = {};
        raw[key] = section;
      } else {
        section = null;
        const parsed = parseValue(rest);
        if (!parsed.ok) {
          return { ok: false, reason: `第 ${lineNo} 行：${parsed.reason}` };
        }
        raw[key] = parsed.value;
      }
    } else if (indent === 2) {
      if (section === null) {
        return { ok: false, reason: `第 ${lineNo} 行缩进无所属小节：${line.trim()}` };
      }
      if (rest === '') {
        return { ok: false, reason: `第 ${lineNo} 行超出两级缩进子集（嵌套小节不支持）：${line.trim()}` };
      }
      const parsed = parseValue(rest);
      if (!parsed.ok) {
        return { ok: false, reason: `第 ${lineNo} 行：${parsed.reason}` };
      }
      section[key] = parsed.value;
    } else {
      return { ok: false, reason: `第 ${lineNo} 行缩进必须是 0 或 2 个空格：${line.trim()}` };
    }
  }
  return { ok: true, raw };
}

export type ProjectFileReadResult =
  | { state: 'missing' }
  | { state: 'not-file' }
  | { state: 'invalid'; reason: string }
  | { state: 'parsed'; raw: RawMap };

/** 读取 <dir>/project.yaml 并做子集解析；四态结果供 doctor 检查项分路。 */
export async function readProjectMetaFile(dir: string): Promise<ProjectFileReadResult> {
  const abs = path.join(dir, PROJECT_FILE);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { state: 'missing' };
    }
    if (code === 'EISDIR') {
      return { state: 'not-file' };
    }
    throw error;
  }
  const parsed = parseProjectMetaText(text);
  return parsed.ok ? { state: 'parsed', raw: parsed.raw } : { state: 'invalid', reason: parsed.reason };
}
