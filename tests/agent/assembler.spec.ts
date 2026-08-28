/**
 * 上下文组装器 v1 测试（TASK-P3-06）。
 * E3：给定场号与人物，产物含目标场全文、相邻场概要、对应人物卡，各槽位不超预算；
 * E4 锚点：contextSlots 形态 ≡ LlmCallEvent.context_slots（与 trace 的核对面）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SLOT_BUDGET_RATIO,
  SLOT_ORDER,
  assembleContext,
  estimateTokens,
  loadBibleCards,
  summarizeScene,
} from '../../src/agent/context/assembler.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-ctx-'));
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  mkdirSync(join(dir, 'story-bible/characters'), { recursive: true });
  writeFileSync(join(dir, 'scenes/010-opening.md'), '# 010 开场\n\n雨夜，电话铃响。\n');
  writeFileSync(join(dir, 'scenes/020-street.md'), '# 020 街头\n\n主角冲进雨里。\n');
  writeFileSync(join(dir, 'scenes/030-home.md'), '# 030 家中\n\n李梅盯着那张旧照片。\n');
  writeFileSync(
    join(dir, 'story-bible/characters/li-mei.yaml'),
    'id: li-mei\nname: 李梅\nfacts:\n  - "左撇子"\n',
  );
  writeFileSync(
    join(dir, 'story-bible/characters/chen-han.yaml'),
    'id: chen-han\nname: 陈寒\nfacts:\n  - "退役拳手"\n',
  );
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  skillId: 'generate_outline',
  inputs: { premise: '雨夜来电', format: '短剧' },
};

describe('agent/context：组装器 E3 验收', () => {
  it('给定场号与人物：含目标场全文、相邻场概要、对应人物卡', async () => {
    const ctx = await assembleContext({ projectDir: dir, sceneId: '020', characterIds: ['li-mei'], ...BASE });
    expect(ctx.slots.script).toContain('【目标场 020 全文】');
    expect(ctx.slots.script).toContain('主角冲进雨里');
    expect(ctx.slots.script).toContain('【相邻场 010 概要】');
    expect(ctx.slots.script).toContain('【相邻场 030 概要】');
    expect(ctx.slots.bible).toContain('左撇子');
    expect(ctx.slots.bible).not.toContain('退役拳手'); // 未涉及的人物不检出
    expect(ctx.slots.rules).toContain('事实纪律');
    expect(ctx.slots.skill).toContain('雨夜来电');
    expect(ctx.slots.output_spec).toContain('outline-draft');
  });

  it('contextSlots 引用与实际一致（E4 锚点）：bible=id 列表，script=场号#full|#summary', async () => {
    const ctx = await assembleContext({ projectDir: dir, sceneId: '020', characterIds: ['li-mei'], ...BASE });
    expect(ctx.contextSlots).toEqual({
      bible: ['li-mei'],
      script: ['020#full', '010#summary', '030#summary'],
    });
  });

  it('各槽位不超预算（默认 8000 token × 占比）', async () => {
    const ctx = await assembleContext({ projectDir: dir, sceneId: '020', ...BASE });
    for (const slot of SLOT_ORDER) {
      // 截断标记自身占少量 token，容差 +8
      expect(ctx.tokenCounts[slot]).toBeLessThanOrEqual(
        Math.floor(8000 * SLOT_BUDGET_RATIO[slot]) + 8,
      );
    }
  });

  it('超预算确定性截断：内容保留前缀 + 截断标记，不丢槽位', async () => {
    const huge = '字'.repeat(2000);
    writeFileSync(join(dir, 'story-bible/characters/huge.yaml'), `id: huge\nname: 大\nfacts:\n  - "${huge}"\n`);
    const ctx = await assembleContext({ projectDir: dir, characterIds: ['huge'], tokenBudget: 1000, ...BASE });
    expect(ctx.slots.bible).toContain('…（超预算截断）');
    expect(ctx.tokenCounts.bible).toBeLessThanOrEqual(Math.floor(1000 * 0.2) + 8);
    expect(ctx.slots.rules).not.toBe(''); // 别的槽位不受影响
  });

  it('缺省 characterIds = 全部卡；缺省 sceneId → script 槽空', async () => {
    const ctx = await assembleContext({ projectDir: dir, ...BASE });
    expect(ctx.contextSlots.bible).toEqual(['chen-han', 'li-mei']); // 文件名升序
    expect(ctx.contextSlots.script).toEqual([]);
    expect(ctx.slots.script).toBe('');
  });

  it('未注册技能抛错；无 story-bible 目录 = 空 bible 槽不报错', async () => {
    await expect(
      assembleContext({ projectDir: dir, skillId: 'ghost', inputs: {} }),
    ).rejects.toThrowError(/技能未注册/);
    rmSync(join(dir, 'story-bible'), { recursive: true, force: true });
    const ctx = await assembleContext({ projectDir: dir, ...BASE });
    expect(ctx.contextSlots.bible).toEqual([]);
  });
});

describe('agent/context：单元（估算/概要/人物卡加载）', () => {
  it('estimateTokens：1 token ≈ 2 字符（向上取整）', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(3);
  });

  it('summarizeScene：标题 + 首段截 80 字符，跳过注释行', () => {
    expect(summarizeScene('# 010 开场\n<!-- 注释 -->\n雨夜。\n')).toBe('# 010 开场 雨夜。');
  });

  it('loadBibleCards：id/name 取自 YAML；缺字段回退文件名', async () => {
    const cards = await loadBibleCards(dir);
    expect(cards.get('li-mei')?.name).toBe('李梅');
    expect(cards.has('chen-han')).toBe(true);
  });
});
