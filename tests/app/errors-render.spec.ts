import { describe, expect, it } from 'vitest';
import { SwError } from '../../src/app/errors/registry.js';
import {
  formatTemplate,
  formatTemplateValue,
  renderError,
  renderHint,
  renderUnexpectedError,
} from '../../src/app/errors/render.js';

describe('app/errors/render：三段式错误渲染（SPEC-03 消息模板）', () => {
  const sample = renderError(new SwError('SW-E011', { cwd: '/home/writer/somewhere' }));
  const lines = sample.split('\n');

  it('结构为 4 行：✖ 码+标题 / 原因 / 怎么办 / 详情（三段式 + 锚点，缺一不可）', () => {
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('✖ SW-E011 当前目录不是 script-writer 项目');
    expect(lines[1]).toMatch(/^ {2}原因：.+/);
    expect(lines[2]).toMatch(/^ {2}怎么办：.+/);
    expect(lines[3]).toMatch(/^ {2}详情：https:\/\/.+/);
  });

  it('详情行锚点指向该码的 docs/errors/ 页面', () => {
    expect(lines[3]).toContain('docs/errors/SW-E011.md');
  });

  it('ctx 插值出现在输出中（E011 的查找位置）', () => {
    expect(sample).toContain('/home/writer/somewhere');
  });

  it('「怎么办」段含可复制命令（SPEC-03 示例：sw init）', () => {
    expect(lines[2]).toContain('`sw init`');
  });

  it('E030 渲染附现有 id 列表（SPEC-03 注册表要求），数组以「、」连接', () => {
    const rendered = renderError(
      new SwError('SW-E030', { sceneId: '040', existingIds: ['010', '020', '030'] }),
    );
    expect(rendered).toContain('✖ SW-E030 场景 040 不存在');
    expect(rendered).toContain('010、020、030');
  });

  it('E030 现有 id 为空数组时渲染为「（无）」而非空串', () => {
    const rendered = renderError(new SwError('SW-E030', { sceneId: '040', existingIds: [] }));
    expect(rendered).toContain('（无）');
  });
});

describe('app/errors/render：模板工具', () => {
  it('formatTemplateValue：字符串/数字原样、数组以「、」连接、空数组为「（无）」', () => {
    expect(formatTemplateValue('abc')).toBe('abc');
    expect(formatTemplateValue(7)).toBe('7');
    expect(formatTemplateValue(['a', 'b'])).toBe('a、b');
    expect(formatTemplateValue([])).toBe('（无）');
  });

  it('formatTemplate：未知占位符原样保留（漂移由注册表 lint 拦截，不静默吞掉）', () => {
    expect(formatTemplate('目录 {dir} 与 {unknown}', { dir: './x' })).toBe('目录 ./x 与 {unknown}');
  });
});

describe('app/errors/render：空态三要素渲染（P1 §6.3）', () => {
  const rendered = renderHint('scenes-empty', {});
  const lines = rendered.split('\n');

  it('结构为 3 行：○ 这里是什么 / 示例 / 下一步', () => {
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^○ .+/);
    expect(lines[1]).toMatch(/^ {2}示例：.+/);
    expect(lines[2]).toMatch(/^ {2}下一步：.+/);
  });

  it('scenes/ 空态内嵌可复制的 sw draft 命令（P1 §6.3 原句落实）', () => {
    expect(lines[2]).toBe('  下一步：sw draft 010 --title "开场"');
  });

  it('outline 空态引导 sw outline', () => {
    expect(renderHint('outline-empty', {})).toContain('下一步：sw outline');
  });
});

describe('app/errors/render：裸异常兜底', () => {
  it('未经 fail() 的异常渲染为可上报形态（含反馈指引与堆栈详情）', () => {
    const rendered = renderUnexpectedError(new Error('boom'));
    expect(rendered).toContain('未预期的内部错误');
    expect(rendered).toContain('issues');
    expect(rendered).toContain('boom');
  });

  it('非 Error 值也能渲染（防兜底自身抛错）', () => {
    expect(renderUnexpectedError('字符串异常')).toContain('字符串异常');
  });
});
