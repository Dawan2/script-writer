/**
 * Agent 层·提示词库加载器与注册表（TASK-P3-02 最小版，P3 方案 §2.8）。
 *
 * 注册即校验（方案规则 2）——load 时逐项拒载：
 * ① frontmatter 形态非法（bad-frontmatter）；
 * ② 元数据缺/错：id 非空串、version 正整数、inputs 值为 required|optional、
 *    output_schema 必填（bad-meta / missing-output-schema）；
 * ③ output_schema 指向的 schema 文件不存在（schema-not-found）；
 * ④ 槽位与模板占位符不一致（slot-mismatch，双向严格：正文 {{槽}} ⊆ inputs ∪ 保留槽
 *    {{rules}}，且 inputs 中每个槽都须在正文出现——声明了不用同样拒载）；
 * ⑤ id@version 重复注册（duplicate-skill）；
 * ⑥ schemas/*.json 非合法 JSON（bad-schema-json）。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  PromptStoreError,
  type PromptStore,
  type Skill,
  type SkillMeta,
  type SlotKind,
} from './types.js';

/** 正文保留槽：{{rules}} 由上下文组装器注入规则集（方案 §2.3 槽位表），不属于技能 inputs。 */
const RESERVED_SLOTS: readonly string[] = ['rules'];

/** 提取正文中的 {{槽位}} 占位符（去重、保序）。 */
export function extractPlaceholders(body: string): readonly string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) {
    const name = match[1];
    if (name !== undefined && !found.includes(name)) found.push(name);
  }
  return found;
}

/** 解析技能 Markdown：frontmatter（YAML）+ 正文。 */
export function parseSkillMarkdown(
  file: string,
  text: string,
): { readonly meta: SkillMeta; readonly body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (match === null) {
    throw new PromptStoreError(file, 'bad-frontmatter', '缺 --- 包裹的元数据头');
  }
  const [, header = '', body = ''] = match;

  let raw: unknown;
  try {
    raw = parseYaml(header);
  } catch (error) {
    throw new PromptStoreError(
      file,
      'bad-frontmatter',
      `元数据头不是合法 YAML：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PromptStoreError(file, 'bad-meta', '元数据头须是键值映射');
  }
  const meta = raw as Record<string, unknown>;

  if (typeof meta.id !== 'string' || meta.id.trim() === '') {
    throw new PromptStoreError(file, 'bad-meta', 'id 须是非空字符串');
  }
  if (typeof meta.version !== 'number' || !Number.isInteger(meta.version) || meta.version < 1) {
    throw new PromptStoreError(file, 'bad-meta', 'version 须是正整数（技能改动必须递增）');
  }
  if (meta.output_schema === undefined) {
    throw new PromptStoreError(file, 'missing-output-schema', '缺 output_schema（技能必须声明输出 schema）');
  }
  if (typeof meta.output_schema !== 'string' || !meta.output_schema.startsWith('prompts/schemas/')) {
    throw new PromptStoreError(file, 'bad-meta', 'output_schema 须指向 prompts/schemas/ 下路径');
  }
  const inputs: Record<string, SlotKind> = {};
  const rawInputs = meta.inputs ?? {};
  if (typeof rawInputs !== 'object' || rawInputs === null || Array.isArray(rawInputs)) {
    throw new PromptStoreError(file, 'bad-meta', 'inputs 须是键值映射（值：required|optional）');
  }
  for (const [slot, kind] of Object.entries(rawInputs as Record<string, unknown>)) {
    if (kind !== 'required' && kind !== 'optional') {
      throw new PromptStoreError(file, 'bad-meta', `inputs.${slot} 须为 required|optional`);
    }
    if (RESERVED_SLOTS.includes(slot)) {
      throw new PromptStoreError(file, 'bad-meta', `inputs.${slot} 与保留槽冲突`);
    }
    inputs[slot] = kind;
  }

  return {
    meta: { id: meta.id, version: meta.version, inputs, outputSchema: meta.output_schema },
    body,
  };
}

/** 校验技能：schema 存在 + 槽位双向一致。 */
export function validateSkill(
  file: string,
  meta: SkillMeta,
  body: string,
  schemaPaths: ReadonlySet<string>,
): void {
  if (!schemaPaths.has(meta.outputSchema)) {
    throw new PromptStoreError(file, 'schema-not-found', `output_schema 不存在：${meta.outputSchema}`);
  }
  const placeholders = extractPlaceholders(body).filter((s) => !RESERVED_SLOTS.includes(s));
  const declared = Object.keys(meta.inputs);
  const undeclared = placeholders.filter((s) => !declared.includes(s));
  const unused = declared.filter((s) => !placeholders.includes(s));
  if (undeclared.length > 0 || unused.length > 0) {
    const parts: string[] = [];
    if (undeclared.length > 0) parts.push(`正文占位符未在 inputs 声明：${undeclared.join('、')}`);
    if (unused.length > 0) parts.push(`inputs 声明未在正文使用：${unused.join('、')}`);
    throw new PromptStoreError(file, 'slot-mismatch', parts.join('；'));
  }
}

async function listMd(dir: string): Promise<readonly string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return []; // 层目录缺省视为空层（rules 可空，技能层同理）
  }
}

/** 加载提示词库（rootDir = 仓库根或含 prompts/ 的目录；注册即校验，非法即抛）。 */
export async function loadPromptStore(rootDir: string): Promise<PromptStore> {
  const promptsDir = join(rootDir, 'prompts');
  const schemasDir = join(promptsDir, 'schemas');

  // schemas 层：先收路径集（技能存在性校验的数据源），并验证 JSON 可解析。
  const schemaPaths = new Set<string>();
  const schemaFiles = await (async (): Promise<readonly string[]> => {
    try {
      return (await readdir(schemasDir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
  })();
  for (const name of schemaFiles) {
    const rel = `prompts/schemas/${name}`;
    try {
      JSON.parse(await readFile(join(schemasDir, name), 'utf8'));
    } catch {
      throw new PromptStoreError(rel, 'bad-schema-json', 'schema 文件不是合法 JSON');
    }
    schemaPaths.add(rel);
  }

  // rules 层：每文件一条规则集。
  const rulesDir = join(promptsDir, 'rules');
  const rules = [];
  for (const name of await listMd(rulesDir)) {
    rules.push({ id: name.replace(/\.md$/, ''), body: await readFile(join(rulesDir, name), 'utf8') });
  }

  // skills 层：解析 + 校验 + 注册（重复 id@version 拒载）。
  const skillsDir = join(promptsDir, 'skills');
  const skills = new Map<string, Skill>();
  const seenRefs = new Set<string>();
  for (const name of await listMd(skillsDir)) {
    const file = `prompts/skills/${name}`;
    const { meta, body } = parseSkillMarkdown(file, await readFile(join(skillsDir, name), 'utf8'));
    validateSkill(file, meta, body, schemaPaths);
    const ref = `${meta.id}@${meta.version}`;
    if (seenRefs.has(ref)) {
      throw new PromptStoreError(file, 'duplicate-skill', `重复注册：${ref}`);
    }
    seenRefs.add(ref);
    skills.set(meta.id, { meta, ref, body });
  }

  return {
    rules,
    skills,
    schemaPaths,
    skillRef(id) {
      return skills.get(id)?.ref;
    },
  };
}
