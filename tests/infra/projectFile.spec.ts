import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectMeta } from '../../src/core/model/project.js';
import {
  inspectDir,
  materializeProjectDir,
  serializeProjectMeta,
} from '../../src/infra/store/projectFile.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sw-projectfile-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('infra/store/projectFile · serializeProjectMeta', () => {
  it('输出 SPEC-01 schema v1 全文（含 GAP-03 expectedSceneCount 与 ADR-0001 markdown 勘误）', () => {
    const meta = createProjectMeta({
      title: '我的短片',
      format: 'short-video',
      created: '2026-08-27',
      expectedSceneCount: 5,
    });
    expect(serializeProjectMeta(meta)).toBe(
      [
        'schema: 1',
        'title: "我的短片"',
        'format: short-video',
        'created: 2026-08-27',
        'expectedSceneCount: 5',
        'settings:',
        '  ai: { enabled: false, provider: null }',
        '  export: { default: markdown }',
        'progress:',
        '  step: outline',
        '  scenes_done: []',
        '',
      ].join('\n'),
    );
  });

  it('expectedSceneCount 缺省时不输出该行（可选字段）', () => {
    const meta = createProjectMeta({ title: 't', created: '2026-08-27' });
    expect(serializeProjectMeta(meta)).not.toContain('expectedSceneCount');
  });

  it('标题经 JSON 转义（双引号/换行等特殊字符安全）', () => {
    const meta = createProjectMeta({ title: '他说："开拍"', created: '2026-08-27' });
    expect(serializeProjectMeta(meta)).toContain('title: "他说：\\"开拍\\""');
  });
});

describe('infra/store/projectFile · inspectDir', () => {
  it('区分 missing / empty / non-empty / file 四态', async () => {
    const root = await makeTempRoot();
    expect(await inspectDir(path.join(root, 'nope'))).toBe('missing');

    const empty = path.join(root, 'empty');
    await mkdir(empty);
    expect(await inspectDir(empty)).toBe('empty');

    const full = path.join(root, 'full');
    await mkdir(full);
    await writeFile(path.join(full, 'x.txt'), 'x', 'utf8');
    expect(await inspectDir(full)).toBe('non-empty');

    const file = path.join(root, 'a-file');
    await writeFile(file, 'x', 'utf8');
    expect(await inspectDir(file)).toBe('file');
  });
});

describe('infra/store/projectFile · materializeProjectDir', () => {
  const files = [
    { relPath: 'project.yaml', content: 'schema: 1\n' },
    { relPath: 'outline.md', content: '# o\n' },
    { relPath: 'scenes/.gitkeep', content: '' },
  ];

  it('目标缺失：整目录 rename，落盘后无 .sw-init-* 临时残留', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'proj');
    await materializeProjectDir(target, files, { dirState: 'missing', ensureDirs: ['exports'] });

    expect(await readFile(path.join(target, 'project.yaml'), 'utf8')).toBe('schema: 1\n');
    expect(await readdir(path.join(target, 'exports'))).toEqual([]);
    expect((await readdir(root)).filter((name) => name.startsWith('.sw-init-'))).toEqual([]);
  });

  it('目标为既有空目录：逐顶层条目落位，同样无临时残留', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'proj');
    await mkdir(target);
    await materializeProjectDir(target, files, { dirState: 'empty', ensureDirs: ['exports'] });

    expect(await readFile(path.join(target, 'outline.md'), 'utf8')).toBe('# o\n');
    expect(await readdir(path.join(target, 'scenes'))).toEqual(['.gitkeep']);
    expect((await readdir(root)).filter((name) => name.startsWith('.sw-init-'))).toEqual([]);
  });

  it('非空目录 + overwrite（--force）：覆盖同名脚手架文件，保留用户文件', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'proj');
    await mkdir(target);
    await writeFile(path.join(target, 'project.yaml'), '旧内容', 'utf8');
    await writeFile(path.join(target, 'notes.txt'), '用户笔记', 'utf8');

    await materializeProjectDir(target, files, { dirState: 'non-empty', ensureDirs: ['exports'] });

    expect(await readFile(path.join(target, 'project.yaml'), 'utf8')).toBe('schema: 1\n');
    expect(await readFile(path.join(target, 'notes.txt'), 'utf8')).toBe('用户笔记');
    expect((await readdir(target)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
