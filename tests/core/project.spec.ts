import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  SCRIPT_FORMATS,
  createProjectMeta,
  isScriptFormat,
} from '../../src/core/model/project.js';

describe('core/model/project', () => {
  it('createProjectMeta 产出 SPEC-01 schema v1 的零配置默认值', () => {
    const meta = createProjectMeta({ title: '我的短片', created: '2026-08-27' });
    expect(meta).toEqual({
      schema: SCHEMA_VERSION,
      title: '我的短片',
      format: 'short-video',
      created: '2026-08-27',
      settings: {
        ai: { enabled: false, provider: null },
        // ADR-0001 §3.6：v1 默认导出格式为 markdown（勘误自 SPEC-01 示例的 fountain）
        export: { default: 'markdown' },
      },
      progress: { step: 'outline', scenesDone: [] },
    });
  });

  it('schema 版本为 1（供未来迁移判定）', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('created 缺省时取 ISO 日期（YYYY-MM-DD）', () => {
    const meta = createProjectMeta({ title: 't' });
    expect(meta.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('format 可显式指定为三种脚本类型之一', () => {
    for (const format of SCRIPT_FORMATS) {
      expect(createProjectMeta({ title: 't', format }).format).toBe(format);
    }
  });

  it('isScriptFormat 只认 screenplay / short-video / podcast', () => {
    expect(isScriptFormat('screenplay')).toBe(true);
    expect(isScriptFormat('short-video')).toBe(true);
    expect(isScriptFormat('podcast')).toBe(true);
    expect(isScriptFormat('novel')).toBe(false);
    expect(isScriptFormat(undefined)).toBe(false);
  });

  it('AI 默认关闭（P1 §5.1 "AI 为可空适配器" 硬约束）', () => {
    expect(createProjectMeta({ title: 't' }).settings.ai).toEqual({ enabled: false, provider: null });
  });
});
