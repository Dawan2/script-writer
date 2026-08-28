/**
 * Agent 层·上下文组装器 v1（TASK-P3-06，P3 方案 §2.3 预算表）。
 *
 * v1 确定性检出（按场号/人物名精确取，无向量检索——行为可预测、可测试）；
 * 槽位顺序与配额固定、可审计：
 *
 * | 槽位        | 预算占比 | 内容 |
 * |-------------|---------|------|
 * | rules       | 5%      | 硬规则（prompts/rules/ 全文） |
 * | skill       | 10%     | 技能模板（渲染后） |
 * | bible       | 20%     | 涉及人物/地点的设定集条目（characters/*.yaml） |
 * | script      | 45%     | 目标场全文 + 相邻场概要 |
 * | session     | 10%     | 会话层（目标、澄清结果，调用方给） |
 * | output_spec | 10%     | 输出 schema 原文 |
 *
 * 超预算处置：确定性截断（截断标记明示），不丢槽位——「模型看到了什么」必须可复盘。
 * token 估算：近似 1 token ≈ 2 字符（CJK 偏保守），估算器单点可替换（v2 换 tokenizer）。
 *
 * 组装结果含 contextSlots 引用（bible: 条目 id 列表；script: 场号#full|#summary），
 * 形态 ≡ LlmCallEvent.context_slots（E4：trace 字段与实际一致的核对锚点）。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { listSceneFiles, readSceneFiles } from '../../infra/store/sceneFile.js';
import { loadPromptStore } from '../prompts/loader.js';
import { loadSchema, renderSkillPrompt } from '../orchestrator/output-guard/index.js';

/** prompts/ 库的仓库根（库资产在仓库而非用户项目——与 skills 文件同址）。 */
const REPO_PROMPTS_ROOT = process.cwd();

/** 槽位名（与方案预算表行序一致）。 */
export const SLOT_ORDER = ['rules', 'skill', 'bible', 'script', 'session', 'output_spec'] as const;
export type ContextSlot = (typeof SLOT_ORDER)[number];

/** 默认预算占比（方案 §2.3 表）。 */
export const SLOT_BUDGET_RATIO: Readonly<Record<ContextSlot, number>> = {
  rules: 0.05,
  skill: 0.10,
  bible: 0.20,
  script: 0.45,
  session: 0.10,
  output_spec: 0.10,
};

/** 默认总预算（token）。 */
export const DEFAULT_TOKEN_BUDGET = 8_000;

/** 近似 token 估算（v1：1 token ≈ 2 字符；单点替换位，v2 评估真 tokenizer）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/** 组装产物。 */
export interface AssembledContext {
  /** 各槽位文本（按 SLOT_ORDER 拼接即完整 prompt 素材）。 */
  readonly slots: Readonly<Record<ContextSlot, string>>;
  /** 各槽位实际 token 数（估算口径，trace 用）。 */
  readonly tokenCounts: Readonly<Record<ContextSlot, number>>;
  /** trace context_slots 形态：bible = 条目 id；script = 场号#full|#summary。 */
  readonly contextSlots: Readonly<Record<string, readonly string[]>>;
}

/** 截断：超预算时确定性截断并标记（不丢槽位）。 */
function fitBudget(text: string, budgetTokens: number): string {
  const maxChars = budgetTokens * 2;
  return estimateTokens(text) <= budgetTokens ? text : `${text.slice(0, maxChars)}\n…（超预算截断）`;
}

/** 场景概要（相邻场用）：标题行 + 首段前 80 字符。 */
export function summarizeScene(content: string): string {
  const lines = content.split('\n').map((l) => l.trim());
  const title = lines.find((l) => l.startsWith('#')) ?? '';
  const firstPara = lines.find((l) => l !== '' && !l.startsWith('#') && !l.startsWith('<!--')) ?? '';
  return `${title} ${firstPara.slice(0, 80)}`.trim();
}

/** 读 story-bible/characters/ 全部人物卡（缺目录 = 空）。 */
export async function loadBibleCards(
  projectDir: string,
): Promise<ReadonlyMap<string, { id: string; name: string; raw: string }>> {
  const dir = join(projectDir, 'story-bible', 'characters');
  const cards = new Map<string, { id: string; name: string; raw: string }>();
  const files = await (async (): Promise<readonly string[]> => {
    try {
      return (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort();
    } catch {
      return [];
    }
  })();
  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8');
    const parsed = parseYaml(raw) as { id?: unknown; name?: unknown };
    const id = typeof parsed.id === 'string' ? parsed.id : file.replace(/\.yaml$/, '');
    const name = typeof parsed.name === 'string' ? parsed.name : id;
    cards.set(id, { id, name, raw });
  }
  return cards;
}

/**
 * 组装上下文（确定性检出）：
 * - bible：characters 中涉及的人物（characterIds 指定；缺省 = 全部卡）；
 * - script：sceneId 目标场全文（#full）+ 前后相邻场概要（#summary）。
 */
export async function assembleContext(options: {
  projectDir: string;
  /** 技能 id（须已注册于 prompts/skills/）。 */
  skillId: string;
  /** 技能槽位输入（renderSkillPrompt 口径）。 */
  inputs: Readonly<Record<string, string>>;
  /** 目标场号（可选；给了则 script 槽含该场全文与相邻场概要）。 */
  sceneId?: string;
  /** 涉及人物卡 id（缺省 = 全部卡）。 */
  characterIds?: readonly string[];
  /** 会话层文本（目标/澄清结果，可选）。 */
  sessionText?: string;
  /** 总 token 预算（缺省 8000）。 */
  tokenBudget?: number;
}): Promise<AssembledContext> {
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const slotBudget = (slot: ContextSlot) => Math.floor(budget * SLOT_BUDGET_RATIO[slot]);

  // rules + skill + output_spec（prompts 库为唯一取数面）
  const store = await loadPromptStore(REPO_PROMPTS_ROOT);
  const skill = store.skills.get(options.skillId);
  if (skill === undefined) {
    throw new Error(`技能未注册：${options.skillId}`);
  }
  const rulesText = store.rules.map((r) => r.body.trim()).join('\n\n');
  const skillText = renderSkillPrompt(skill, options.inputs, []).trim();
  const schemaText = JSON.stringify(await loadSchema(REPO_PROMPTS_ROOT, skill.meta.outputSchema));

  // bible：确定性检出人物卡
  const cards = await loadBibleCards(options.projectDir);
  const picked = [...cards.values()].filter(
    (c) => options.characterIds === undefined || options.characterIds.includes(c.id),
  );
  const bibleText = picked.map((c) => c.raw.trim()).join('\n\n---\n\n');

  // script：目标场全文 + 相邻场概要
  const scriptRefs: string[] = [];
  let scriptText = '';
  if (options.sceneId !== undefined) {
    const files = await listSceneFiles(options.projectDir);
    const index = files.findIndex((f) => f.startsWith(`${options.sceneId}-`));
    const all = await readSceneFiles(options.projectDir);
    const target = all.find((f) => f.fileName === files[index]);
    if (target !== undefined && index >= 0) {
      scriptRefs.push(`${options.sceneId}#full`);
      scriptText += `【目标场 ${options.sceneId} 全文】\n${target.content.trim()}\n`;
      for (const neighborIndex of [index - 1, index + 1]) {
        const neighbor = all[neighborIndex];
        if (neighbor !== undefined) {
          const neighborId = /^(\d{3,})-/.exec(neighbor.fileName)?.[1] ?? '';
          scriptRefs.push(`${neighborId}#summary`);
          scriptText += `\n【相邻场 ${neighborId} 概要】${summarizeScene(neighbor.content)}\n`;
        }
      }
    }
  }

  const slots: Record<ContextSlot, string> = {
    rules: fitBudget(rulesText, slotBudget('rules')),
    skill: fitBudget(skillText, slotBudget('skill')),
    bible: fitBudget(bibleText, slotBudget('bible')),
    script: fitBudget(scriptText.trim(), slotBudget('script')),
    session: fitBudget((options.sessionText ?? '').trim(), slotBudget('session')),
    output_spec: fitBudget(schemaText, slotBudget('output_spec')),
  };
  const tokenCounts = Object.fromEntries(
    SLOT_ORDER.map((slot) => [slot, estimateTokens(slots[slot])]),
  ) as Record<ContextSlot, number>;

  return {
    slots,
    tokenCounts,
    contextSlots: {
      bible: picked.map((c) => c.id),
      script: scriptRefs,
    },
  };
}
