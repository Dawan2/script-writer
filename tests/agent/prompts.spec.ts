/**
 * 提示词库加载器测试（TASK-P3-02 最小版）。
 * 真实仓库 prompts/ 目录作正例；临时目录构造拒载负例（槽位不匹配 / 缺 schema 等）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractPlaceholders,
  loadPromptStore,
  parseSkillMarkdown,
} from '../../src/agent/prompts/loader.js';
import { PromptStoreError } from '../../src/agent/prompts/types.js';

const REPO_ROOT = process.cwd();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-prompts-'));
  mkdirSync(join(dir, 'prompts/rules'), { recursive: true });
  mkdirSync(join(dir, 'prompts/skills'), { recursive: true });
  mkdirSync(join(dir, 'prompts/schemas'), { recursive: true });
  writeFileSync(join(dir, 'prompts/schemas/outline-draft.json'), '{"type":"object"}');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID_SKILL = `---
id: demo
version: 2
inputs: {premise: required, tone: optional}
output_schema: prompts/schemas/outline-draft.json
---
正文 {{premise}} {{tone}}
`;

function writeSkill(text: string, name = 'demo.md'): void {
  writeFileSync(join(dir, 'prompts/skills', name), text);
}

describe('agent/prompts：仓库内真实提示词库（E1 结构入库）', () => {
  it('prompts/rules|skills|schemas 三层加载成功：1 规则 + 1 技能（generate_outline@1）+ 1 schema', async () => {
    const store = await loadPromptStore(REPO_ROOT);
    expect(store.rules.map((r) => r.id)).toEqual(['base']);
    expect([...store.skills.keys()]).toEqual(['generate_outline']);
    expect(store.schemaPaths.has('prompts/schemas/outline-draft.json')).toBe(true);
    // trace 中的技能引用恒为 id@version（E4 版本回溯证据的数据源）
    expect(store.skillRef('generate_outline')).toBe('generate_outline@1');
    expect(store.skillRef('nope')).toBeUndefined();
  });

  it('generate_outline 技能：槽位声明与正文占位符一致，规则正文非空', async () => {
    const store = await loadPromptStore(REPO_ROOT);
    const skill = store.skills.get('generate_outline');
    expect(skill?.meta.inputs).toEqual({ premise: 'required', format: 'required', scene_count: 'optional' });
    expect(store.rules[0]?.body).toContain('事实纪律');
  });
});

describe('agent/prompts：占位符提取', () => {
  it('去重保序；非法形态（空格/纯数字）不识别', () => {
    expect(extractPlaceholders('{{a}} {{b}} {{a}} {{ a }} {{1x}} {{_c}}')).toEqual(['a', 'b', '_c']);
  });
});

describe('agent/prompts：注册即校验（E3 拒载矩阵）', () => {
  it('合法技能可加载，ref = id@version', async () => {
    writeSkill(VALID_SKILL);
    const store = await loadPromptStore(dir);
    expect(store.skillRef('demo')).toBe('demo@2');
  });

  it('缺 output_schema → 拒载（missing-output-schema）', async () => {
    writeSkill(VALID_SKILL.replace('output_schema: prompts/schemas/outline-draft.json\n', ''));
    await expect(loadPromptStore(dir)).rejects.toMatchObject({
      name: 'PromptStoreError',
      reason: 'missing-output-schema',
    });
  });

  it('output_schema 指向不存在的文件 → 拒载（schema-not-found）', async () => {
    writeSkill(VALID_SKILL.replace('outline-draft.json', 'ghost.json'));
    await expect(loadPromptStore(dir)).rejects.toMatchObject({ reason: 'schema-not-found' });
  });

  it('正文占位符未声明 → 拒载（slot-mismatch，方向一）', async () => {
    writeSkill(VALID_SKILL.replace('{{tone}}', '{{tone}} {{ghost}}'));
    await expect(loadPromptStore(dir)).rejects.toMatchObject({ reason: 'slot-mismatch' });
  });

  it('inputs 声明未在正文使用 → 拒载（slot-mismatch，方向二）', async () => {
    writeSkill(VALID_SKILL.replace(' {{tone}}', ''));
    await expect(loadPromptStore(dir)).rejects.toMatchObject({ reason: 'slot-mismatch' });
  });

  it('保留槽 {{rules}} 不需声明即可在正文使用', async () => {
    writeSkill(VALID_SKILL.replace('正文', '{{rules}}\n正文'));
    const store = await loadPromptStore(dir);
    expect(store.skillRef('demo')).toBe('demo@2');
  });

  it('version 非正整数 → 拒载（bad-meta）', async () => {
    writeSkill(VALID_SKILL.replace('version: 2', 'version: 0'));
    await expect(loadPromptStore(dir)).rejects.toMatchObject({ reason: 'bad-meta' });
  });

  it('inputs 值非法 → 拒载（bad-meta）', async () => {
    writeSkill(VALID_SKILL.replace('tone: optional', 'tone: maybe'));
    await expect(loadPromptStore(dir)).rejects.toMatchObject({ reason: 'bad-meta' });
  });

  it('缺元数据头 → 拒载（bad-frontmatter）', async () => {
    writeSkill('没有头的正文');
    await expect(loadPromptStore(dir)).rejects.toMatchObject({ reason: 'bad-frontmatter' });
  });

  it('id@version 重复 → 拒载（duplicate-skill）', async () => {
    writeSkill(VALID_SKILL);
    writeSkill(VALID_SKILL, 'demo-copy.md');
    await expect(loadPromptStore(dir)).rejects.toMatchObject({ reason: 'duplicate-skill' });
  });

  it('schema 文件非合法 JSON → 拒载（bad-schema-json）', async () => {
    writeSkill(VALID_SKILL);
    writeFileSync(join(dir, 'prompts/schemas/outline-draft.json'), '{broken');
    await expect(loadPromptStore(dir)).rejects.toMatchObject({ reason: 'bad-schema-json' });
  });

  it('同 id 不同 version 可并存加载（版本化纪律；索引键取文件名排序后者）', async () => {
    writeSkill(VALID_SKILL, 'a-demo-v2.md');
    writeSkill(VALID_SKILL.replace('version: 2', 'version: 3'), 'b-demo-v3.md');
    const store = await loadPromptStore(dir);
    expect(store.skillRef('demo')).toBe('demo@3');
  });
});

describe('agent/prompts：parseSkillMarkdown 单元', () => {
  it('正常解析：meta 强类型 + body 原文', () => {
    const { meta, body } = parseSkillMarkdown('f.md', VALID_SKILL);
    expect(meta).toEqual({
      id: 'demo',
      version: 2,
      inputs: { premise: 'required', tone: 'optional' },
      outputSchema: 'prompts/schemas/outline-draft.json',
    });
    expect(body).toContain('{{premise}}');
  });

  it('PromptStoreError 携带 file 与 reason（测试断言锚点）', () => {
    const error = new PromptStoreError('f.md', 'slot-mismatch', '细节');
    expect(error.file).toBe('f.md');
    expect(error.reason).toBe('slot-mismatch');
    expect(error.message).toContain('细节');
  });
});
