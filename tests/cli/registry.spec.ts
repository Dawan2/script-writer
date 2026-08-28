/**
 * 命令注册表结构单测（SPEC-07 §4.1/§4.2 约束的断言对象，W4-HELP-T01 验收 ③）。
 * 三向一致断言（注册表 ↔ commander 注册 ↔ --all 输出）在 tests/cli/help.spec.ts。
 */
import { describe, expect, it } from 'vitest';
import { COMMAND_REGISTRY } from '../../src/cli/registry.js';

describe('cli/registry：注册表结构约束（SPEC-07 §4.1/§4.2）', () => {
  it('命令名全表唯一', () => {
    const names = COMMAND_REGISTRY.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('别名全表唯一、小写、长度 1–2（§4.2-1）', () => {
    const aliases = COMMAND_REGISTRY.flatMap((s) => (s.alias === undefined ? [] : [s.alias]));
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const alias of aliases) {
      expect(alias).toMatch(/^[a-z]{1,2}$/);
    }
  });

  it('别名不与任何主命令词冲突（§4.2-1）', () => {
    const names = new Set(COMMAND_REGISTRY.map((s) => s.name));
    for (const s of COMMAND_REGISTRY) {
      if (s.alias !== undefined) {
        expect(names.has(s.alias)).toBe(false);
      }
    }
  });

  it('planned 条目零注册（禁填 register），available 必填 register（§4.1-2）', () => {
    for (const s of COMMAND_REGISTRY) {
      if (s.status === 'planned') {
        expect(s.register, `${s.name} 为 planned，不得携带 register`).toBeUndefined();
      } else {
        expect(s.register, `${s.name} 为 available，必须携带 register`).toBeTypeOf('function');
      }
    }
  });

  it('main 组按五步工作流序：init → outline → draft → revise → export → status（§4.1-4）', () => {
    const mainNames = COMMAND_REGISTRY.filter((s) => s.group === 'main').map((s) => s.name);
    expect(mainNames).toEqual(['init', 'outline', 'draft', 'revise', 'export', 'status']);
  });

  it('别名全集 v1 六只：i/o/d/r/x/s 各就其位（§4.2，GAP-02 扩展路径）', () => {
    const aliasOf = (name: string): string | undefined =>
      COMMAND_REGISTRY.find((s) => s.name === name)?.alias;
    expect(aliasOf('init')).toBe('i');
    expect(aliasOf('outline')).toBe('o');
    expect(aliasOf('draft')).toBe('d');
    expect(aliasOf('revise')).toBe('r');
    expect(aliasOf('export')).toBe('x');
    expect(aliasOf('status')).toBe('s');
  });

  it('revise 已在表中且随 W2-GAP-T01 落地转 available（ROADMAP_HELP 漏行缺陷的注册表化修正，§7-7）', () => {
    const revise = COMMAND_REGISTRY.find((s) => s.name === 'revise');
    expect(revise).toBeDefined();
    expect(revise?.status).toBe('available');
    expect(revise?.taskId).toBe('W2-GAP-T01');
    expect(revise?.register).toBeDefined();
  });
});
