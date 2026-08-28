/**
 * GAP-03 顶层可选字段 expectedSceneCount 的解析/序列化契约（W1-P1-T07 追加）：
 * 与并行 init 槽的落盘口径一致（驼峰键、紧随 created、缺失合法），
 * 保证引擎回写（sw outline / markSceneDone 等）不丢向导写入的字段。
 */

import { describe, expect, it } from 'vitest';
import { parseProjectMeta, toProjectFileShape } from '../../src/core/model/parseProject.js';

function baseShape(): Record<string, unknown> {
  return {
    schema: 1,
    title: '我的短片',
    format: 'short-video',
    created: '2026-08-27',
    settings: {
      ai: { enabled: false, provider: null },
      export: { default: 'markdown' },
    },
    progress: { step: 'outline', scenes_done: [] },
  };
}

describe('core/parseProject：expectedSceneCount 可选字段', () => {
  it('缺失合法（旧式文件仍可读），领域模型中该字段为 undefined 且不落盘', () => {
    const parsed = parseProjectMeta(baseShape());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.meta.expectedSceneCount).toBeUndefined();
      expect('expectedSceneCount' in toProjectFileShape(parsed.meta)).toBe(false);
    }
  });

  it('存在且为正整数 → 进入领域模型并无损往返（键序紧随 created）', () => {
    const parsed = parseProjectMeta({ ...baseShape(), expectedSceneCount: 8 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.meta.expectedSceneCount).toBe(8);
      const shape = toProjectFileShape(parsed.meta);
      expect(shape.expectedSceneCount).toBe(8);
      const keys = Object.keys(shape);
      expect(keys.indexOf('expectedSceneCount')).toBe(keys.indexOf('created') + 1);
    }
  });

  it.each([0, -3, 1.5, '5', true])('非法值 %j → malformed，issue 点名该字段', (bad) => {
    const parsed = parseProjectMeta({ ...baseShape(), expectedSceneCount: bad });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.reason === 'malformed') {
      expect(parsed.issues.join('\n')).toContain('expectedSceneCount');
    }
  });

  it('往返稳定：parse → serialize → parse 得到相同领域模型', () => {
    const first = parseProjectMeta({ ...baseShape(), expectedSceneCount: 12 });
    expect(first.ok).toBe(true);
    if (first.ok) {
      const second = parseProjectMeta(
        toProjectFileShape(first.meta) as unknown as Record<string, unknown>,
      );
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.meta).toEqual(first.meta);
      }
    }
  });
});
