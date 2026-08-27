import { describe, expect, it } from 'vitest';
import {
  listTemplates,
  loadTemplate,
  renderTemplateFiles,
} from '../../src/infra/store/templates.js';

describe('infra/store/templates', () => {
  it('内置模板列表含 short-video（W1-P1-T04 首个模板）', async () => {
    expect(await listTemplates()).toContain('short-video');
  });

  it('short-video 模板含大纲/角色/场景/gitignore 完整文件树，gitignore 映射为 .gitignore', async () => {
    const files = await loadTemplate('short-video');
    const paths = files.map((file) => file.relPath).sort();
    expect(paths).toEqual(['.gitignore', 'characters/.gitkeep', 'outline.md', 'scenes/.gitkeep']);
    expect(files.find((file) => file.relPath === '.gitignore')?.content).toContain('exports/');
  });

  it('renderTemplateFiles 替换 {{key}} 占位；未提供的占位原样保留', () => {
    const rendered = renderTemplateFiles(
      [{ relPath: 'outline.md', content: '# {{title}}（{{expectedSceneCount}} 场）{{unknown}}' }],
      { title: '我的短片', expectedSceneCount: '5' },
    );
    expect(rendered[0]?.content).toBe('# 我的短片（5 场）{{unknown}}');
  });

  it('short-video 大纲模板含空态三要素引导（这里是什么/示例/下一步）', async () => {
    const files = await loadTemplate('short-video');
    const outline = files.find((file) => file.relPath === 'outline.md')?.content ?? '';
    expect(outline).toContain('这里是什么');
    expect(outline).toContain('示例');
    expect(outline).toContain('下一步');
  });
});
