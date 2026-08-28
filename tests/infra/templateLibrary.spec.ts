/**
 * 模板库 v1 结构验收（W1-P1-T07）：三选一齐备、文件树同构、占位变量受控、空态三要素内嵌。
 * 注意：tests/infra/templates.spec.ts 与 init 槽（cursor/w2-init-wizard-87b4）字节级一致以便合并，
 * 本文件承载 T07 新增断言，勿并入该文件。
 */

import { describe, expect, it } from 'vitest';
import { SCRIPT_FORMATS } from '../../src/core/model/project.js';
import {
  listTemplates,
  loadTemplate,
  renderTemplateFiles,
} from '../../src/infra/store/templates.js';

const EXPECTED_TREE = ['.gitignore', 'characters/.gitkeep', 'outline.md', 'scenes/.gitkeep'];

/** 模板允许使用的占位变量全集（新增变量须同步 sw outline / sw init 的渲染入参）。 */
const ALLOWED_VARS = new Set(['title', 'expectedSceneCount']);

describe('templates/ 模板库 v1（三选一，W1-P1-T07）', () => {
  it('内置模板 id 集合与脚本类型枚举（SCRIPT_FORMATS）一致——format 即模板 id', async () => {
    const ids = await listTemplates();
    expect([...ids].sort()).toEqual([...SCRIPT_FORMATS].sort());
  });

  it.each([...SCRIPT_FORMATS])('模板 %s：文件树完整且与 short-video 同构', async (id) => {
    const files = await loadTemplate(id);
    expect(files.map((file) => file.relPath).sort()).toEqual(EXPECTED_TREE);
    expect(files.find((file) => file.relPath === '.gitignore')?.content).toContain('exports/');
  });

  it.each([...SCRIPT_FORMATS])(
    '模板 %s：outline.md 含空态三要素（这里是什么/示例/下一步）与两个占位变量',
    async (id) => {
      const files = await loadTemplate(id);
      const outline = files.find((file) => file.relPath === 'outline.md')?.content ?? '';
      for (const marker of ['这里是什么', '示例', '下一步']) {
        expect(outline).toContain(marker);
      }
      expect(outline).toContain('{{title}}');
      expect(outline).toContain('{{expectedSceneCount}}');
    },
  );

  it.each([...SCRIPT_FORMATS])(
    '模板 %s：全部占位变量都在允许集合内（防拼写漂移导致渲染残留）',
    async (id) => {
      const files = await loadTemplate(id);
      for (const file of files) {
        const used = [...file.content.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]);
        for (const key of used) {
          expect(ALLOWED_VARS.has(key ?? '')).toBe(true);
        }
      }
    },
  );

  it.each([...SCRIPT_FORMATS])(
    '模板 %s：代入 title/expectedSceneCount 后 outline.md 无占位残留',
    async (id) => {
      const files = await loadTemplate(id);
      const rendered = renderTemplateFiles(files, { title: '我的项目', expectedSceneCount: '5' });
      const outline = rendered.find((file) => file.relPath === 'outline.md')?.content ?? '';
      expect(outline).toContain('我的项目');
      expect(outline).not.toContain('{{');
    },
  );
});
