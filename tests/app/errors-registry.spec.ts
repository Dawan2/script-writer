import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_REGISTRY,
  HINT_REGISTRY,
  HINT_SLOTS,
  SwError,
  errorDocsUrl,
  errorSegment,
  fail,
  isErrorCode,
  isHintSlot,
  isSwError,
} from '../../src/app/errors/registry.js';
import { formatTemplate, renderError, renderHint } from '../../src/app/errors/render.js';

describe('app/errors/registry：错误码注册表（SPEC-03）', () => {
  it('恰好收录 SPEC-01/02 实际触达的错误码（「禁止预填未用码」回归锁，W1-P1-T06 风险条款；W3 集成追加引擎触达的 E021/E022 与 init 触达的 E013/E031）', () => {
    expect([...ERROR_CODES].sort()).toEqual([
      'SW-E010',
      'SW-E011',
      'SW-E013',
      'SW-E020',
      'SW-E021',
      'SW-E022',
      'SW-E030',
      'SW-E031',
    ]);
    // AI 段 SW-E04x 在 AI 适配器落地前不得登记；SW-E012 留给 GAP-04 文件锁（落地前不预填）
    expect(ERROR_CODES.some((code) => code.startsWith('SW-E04'))).toBe(false);
    expect(ERROR_CODES.includes('SW-E012' as (typeof ERROR_CODES)[number])).toBe(false);
  });

  it.each(ERROR_CODES)('%s：码格式为 SW-E + 三位数字，且段位可解析', (code) => {
    expect(code).toMatch(/^SW-E\d{3}$/);
    expect(errorSegment(code)).not.toContain('未命名段');
  });

  it.each(ERROR_CODES)('%s：三段式（发生了什么 / 原因 / 怎么办）全部非空', (code) => {
    const spec = ERROR_REGISTRY[code];
    expect(spec.what.trim()).not.toBe('');
    expect(spec.why.trim()).not.toBe('');
    expect(spec.fix.trim()).not.toBe('');
  });

  it.each(ERROR_CODES)('%s：样例 ctx 渲染后无未解析的 {placeholder}（模板与 ctx 契约一致）', (code) => {
    const rendered = renderError(new SwError(code, ERROR_REGISTRY[code].example));
    expect(rendered).not.toMatch(/\{[a-zA-Z][a-zA-Z0-9]*\}/);
  });

  it.each(ERROR_CODES)('%s：文档锚点指向 docs/errors/ 下的同名生成物', (code) => {
    expect(errorDocsUrl(code)).toBe(
      `https://github.com/Dawan2/script-writer/blob/main/docs/errors/${code}.md`,
    );
  });
});

describe('app/errors/registry：fail() 唯一抛错入口与 SwError', () => {
  it('fail(code, ctx) 抛出 SwError，code 与 ctx 原样携带', () => {
    try {
      fail('SW-E030', { sceneId: '040', existingIds: ['010', '020'] });
      expect.unreachable('fail() 必须抛错');
    } catch (error) {
      expect(isSwError(error)).toBe(true);
      const swError = error as SwError<'SW-E030'>;
      expect(swError.code).toBe('SW-E030');
      expect(swError.ctx).toEqual({ sceneId: '040', existingIds: ['010', '020'] });
    }
  });

  it('SwError 是 Error 子类，message 含错误码与标题（日志可读，不作为用户输出）', () => {
    const error = new SwError('SW-E011', { cwd: '/tmp/nowhere' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SwError');
    expect(error.message).toContain('SW-E011');
    expect(error.message).toContain('当前目录不是 script-writer 项目');
  });

  it('isSwError 能区分普通 Error 与非异常值', () => {
    expect(isSwError(new Error('SW-E011 假冒'))).toBe(false);
    expect(isSwError('SW-E011')).toBe(false);
    expect(isSwError(undefined)).toBe(false);
  });

  it('isErrorCode 只认注册表中的码', () => {
    expect(isErrorCode('SW-E011')).toBe(true);
    expect(isErrorCode('SW-E999')).toBe(false);
    expect(isErrorCode('E011')).toBe(false);
  });
});

describe('app/errors/registry：空态注册表（与错误文案同库、同 lint）', () => {
  it('v1 恰好收录 P1 §6.3 点名的两个位点（scenes-empty / outline-empty）', () => {
    expect([...HINT_SLOTS].sort()).toEqual(['outline-empty', 'scenes-empty']);
  });

  it.each(HINT_SLOTS)('%s：空态三要素（这里是什么 / 示例 / 下一步）全部非空', (slot) => {
    const spec = HINT_REGISTRY[slot];
    expect(spec.what.trim()).not.toBe('');
    expect(spec.example.trim()).not.toBe('');
    expect(spec.next.trim()).not.toBe('');
  });

  it.each(HINT_SLOTS)('%s：「下一步」是以 sw 开头的可复制命令', (slot) => {
    const spec = HINT_REGISTRY[slot];
    const next = formatTemplate(spec.next, spec.exampleCtx);
    expect(next).toMatch(/^sw( |$)/);
  });

  it.each(HINT_SLOTS)('%s：样例 ctx 渲染后无未解析占位符', (slot) => {
    const rendered = renderHint(slot, HINT_REGISTRY[slot].exampleCtx);
    expect(rendered).not.toMatch(/\{[a-zA-Z][a-zA-Z0-9]*\}/);
  });

  it('isHintSlot 只认注册表中的位点', () => {
    expect(isHintSlot('scenes-empty')).toBe(true);
    expect(isHintSlot('characters-empty')).toBe(false);
  });
});
