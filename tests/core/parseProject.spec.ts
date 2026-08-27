import { describe, expect, it } from 'vitest';
import { createProjectMeta, SCHEMA_VERSION } from '../../src/core/model/project.js';
import { parseProjectMeta, toProjectFileShape } from '../../src/core/model/parseProject.js';

/** SPEC-01 示例的合法数据体（ADR-0001 §3.6 勘误：默认导出 markdown）。 */
function validShape(): Record<string, unknown> {
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

describe('core/model/parseProject', () => {
  it('schema v1 工厂产物 → 磁盘形态 → 解析可无损往返（工厂衔接契约）', () => {
    const meta = createProjectMeta({ title: '我的短片', created: '2026-08-27' });
    const parsed = parseProjectMeta(toProjectFileShape(meta));
    expect(parsed).toEqual({ ok: true, meta });
  });

  it('磁盘形态使用 SPEC-01 的键名（snake_case scenes_done）', () => {
    const meta = createProjectMeta({ title: 't', created: '2026-08-27' });
    const shape = toProjectFileShape(meta);
    expect(shape.progress).toEqual({ step: 'outline', scenes_done: [] });
    expect('scenesDone' in shape.progress).toBe(false);
  });

  it('解析 SPEC-01 示例形态的数据体', () => {
    const parsed = parseProjectMeta(validShape());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.meta.title).toBe('我的短片');
      expect(parsed.meta.progress.scenesDone).toEqual([]);
    }
  });

  it('schema 版本不符 → schema-incompatible（SW-E020 语义，附双方版本）', () => {
    const parsed = parseProjectMeta({ ...validShape(), schema: 2 });
    expect(parsed).toEqual({
      ok: false,
      reason: 'schema-incompatible',
      found: 2,
      expected: SCHEMA_VERSION,
    });
  });

  it('缺 schema 字段 → malformed（无从判断版本，不误报为不兼容）', () => {
    const shape = validShape();
    delete shape['schema'];
    const parsed = parseProjectMeta(shape);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('malformed');
  });

  it('字段畸形时逐条列出 issues（供三段式错误消息）', () => {
    const parsed = parseProjectMeta({
      schema: 1,
      title: '',
      format: 'novel',
      created: '昨天',
      settings: { ai: { enabled: 'yes', provider: null }, export: {} },
      progress: { step: 'chapter', scenes_done: [10] },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.reason === 'malformed') {
      expect(parsed.issues.length).toBeGreaterThanOrEqual(6);
      expect(parsed.issues.join('\n')).toContain('title');
      expect(parsed.issues.join('\n')).toContain('scenes_done');
    }
  });

  it('顶层不是映射（如 YAML 解析出字符串/null）→ malformed 不抛裸异常', () => {
    for (const bad of [null, 'text', 42, ['a']]) {
      const parsed = parseProjectMeta(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe('malformed');
    }
  });

  it('scenes_done 有内容时原样进入领域模型', () => {
    const shape = validShape();
    (shape['progress'] as Record<string, unknown>)['scenes_done'] = ['010', '020'];
    (shape['progress'] as Record<string, unknown>)['step'] = 'draft';
    const parsed = parseProjectMeta(shape);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.meta.progress).toEqual({ step: 'draft', scenesDone: ['010', '020'] });
    }
  });
});
