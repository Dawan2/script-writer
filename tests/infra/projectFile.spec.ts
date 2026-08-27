import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createProjectMeta } from '../../src/core/model/project.js';
import { parseProjectMeta } from '../../src/core/model/parseProject.js';
import {
  inspectDir,
  materializeProjectDir,
  readProjectFileRaw,
  scanProjectDisk,
  serializeProjectFile,
  writeProjectFile,
} from '../../src/infra/store/projectFile.js';
import { PROJECT_FILE } from '../../src/infra/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('infra/store/projectFile', () => {
  it('写入 → 读取 → 解析可无损往返（YAML 契约 + 工厂衔接）', async () => {
    const meta = createProjectMeta({ title: '我的短片', created: '2026-08-27' });
    await writeProjectFile(dir, meta);
    const raw = await readProjectFileRaw(dir);
    expect(raw).toMatchObject({ exists: true, ok: true });
    if (raw.exists && raw.ok) {
      expect(parseProjectMeta(raw.data)).toEqual({ ok: true, meta });
    }
  });

  it('落盘 YAML 人类可读且键名与 SPEC-01 一致（用户可直接编辑）', async () => {
    const meta = createProjectMeta({ title: '我的短片', created: '2026-08-27' });
    await writeProjectFile(dir, meta);
    const text = await readFile(join(dir, PROJECT_FILE), 'utf8');
    expect(text).toContain('schema: 1');
    expect(text).toContain('format: short-video');
    expect(text).toContain('scenes_done:');
    expect(text).toContain('step: outline');
  });

  it('无 project.yaml → exists:false（SW-E011 判定的数据源）', async () => {
    expect(await readProjectFileRaw(dir)).toEqual({ exists: false });
  });

  it('project.yaml 不是合法 YAML → 结构化解析失败，不抛裸异常', async () => {
    await writeFile(join(dir, PROJECT_FILE), 'title: [未闭合');
    const raw = await readProjectFileRaw(dir);
    expect(raw.exists).toBe(true);
    if (raw.exists) {
      expect(raw.ok).toBe(false);
    }
  });

  it('scanProjectDisk 汇报 outline 与场编号（忽略不合命名约定的文件）', async () => {
    await writeFile(join(dir, 'outline.md'), '# 大纲');
    await mkdir(join(dir, 'scenes'));
    await writeFile(join(dir, 'scenes', '020-chase.md'), '');
    await writeFile(join(dir, 'scenes', '010-opening.md'), '');
    await writeFile(join(dir, 'scenes', 'notes.txt'), '');
    await writeFile(join(dir, 'scenes', 'draft.md'), '');
    const disk = await scanProjectDisk(dir);
    expect(disk).toEqual({ outlineExists: true, sceneIds: ['010', '020'] });
  });

  it('scanProjectDisk 对空项目（无 outline、无 scenes/）给出空快照', async () => {
    expect(await scanProjectDisk(dir)).toEqual({ outlineExists: false, sceneIds: [] });
  });
});

// ---------------------------------------------------------------------------
// W3 集成迁移：以下断言自 init 分支的 projectFile.spec 迁移保留（integration-map §2.3）。
// serializeProjectMeta（手写 YAML）已废弃，序列化断言等价替换为 engine 正典
// serializeProjectFile（toProjectFileShape + yaml.stringify）路径。
// ---------------------------------------------------------------------------

describe('infra/store/projectFile · serializeProjectFile（原 serializeProjectMeta 断言迁移）', () => {
  it('输出 schema v1 全文（含 GAP-03 expectedSceneCount 与 ADR-0001 markdown 勘误，engine 序列化形态）', () => {
    const meta = createProjectMeta({
      title: '我的短片',
      format: 'short-video',
      created: '2026-08-27',
      expectedSceneCount: 5,
    });
    expect(serializeProjectFile(meta)).toBe(
      [
        'schema: 1',
        'title: 我的短片',
        'format: short-video',
        'created: 2026-08-27',
        'expectedSceneCount: 5',
        'settings:',
        '  ai:',
        '    enabled: false',
        '    provider: null',
        '  export:',
        '    default: markdown',
        'progress:',
        '  step: outline',
        '  scenes_done: []',
        '',
      ].join('\n'),
    );
  });

  it('expectedSceneCount 缺省时不输出该行（可选字段，旧式文件兼容）', () => {
    const meta = createProjectMeta({ title: 't', created: '2026-08-27' });
    expect(serializeProjectFile(meta)).not.toContain('expectedSceneCount');
  });

  it('标题特殊字符（双引号/冒号等）序列化后可无损解析回原文', () => {
    const meta = createProjectMeta({ title: '他说："开拍"', created: '2026-08-27' });
    const text = serializeProjectFile(meta);
    const data: unknown = parse(text);
    expect((data as { title: string }).title).toBe('他说："开拍"');
    expect(parseProjectMeta(data)).toEqual({ ok: true, meta });
  });
});

describe('infra/store/projectFile · expectedSceneCount 存储往返（语义冲突 ⑥：数据丢失级堵点）', () => {
  it('有字段：写入 → 读取 → 解析往返保留 expectedSceneCount', async () => {
    const meta = createProjectMeta({ title: '往返', created: '2026-08-27', expectedSceneCount: 8 });
    await writeProjectFile(dir, meta);
    const raw = await readProjectFileRaw(dir);
    expect(raw).toMatchObject({ exists: true, ok: true });
    if (raw.exists && raw.ok) {
      const parsed = parseProjectMeta(raw.data);
      expect(parsed).toEqual({ ok: true, meta });
      if (parsed.ok) {
        expect(parsed.meta.expectedSceneCount).toBe(8);
      }
    }
  });

  it('无字段：往返后字段依然缺省（不冒出 null / undefined 键）', async () => {
    const meta = createProjectMeta({ title: '往返', created: '2026-08-27' });
    await writeProjectFile(dir, meta);
    const raw = await readProjectFileRaw(dir);
    if (raw.exists && raw.ok) {
      const parsed = parseProjectMeta(raw.data);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect('expectedSceneCount' in parsed.meta).toBe(false);
      }
    }
  });

  it('expectedSceneCount 非正整数时解析报字段畸形（GAP-03 正整数约束）', () => {
    const base = createProjectMeta({ title: 't', created: '2026-08-27' });
    const data: unknown = parse(serializeProjectFile(base));
    const tampered = { ...(data as Record<string, unknown>), expectedSceneCount: 0 };
    const parsed = parseProjectMeta(tampered);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok && parsed.reason === 'malformed') {
      expect(parsed.issues.join('\n')).toContain('expectedSceneCount');
    }
  });
});

describe('infra/store/projectFile · inspectDir（自 init 分支迁移）', () => {
  it('区分 missing / empty / non-empty / file 四态', async () => {
    expect(await inspectDir(join(dir, 'nope'))).toBe('missing');

    const empty = join(dir, 'empty');
    await mkdir(empty);
    expect(await inspectDir(empty)).toBe('empty');

    const full = join(dir, 'full');
    await mkdir(full);
    await writeFile(join(full, 'x.txt'), 'x', 'utf8');
    expect(await inspectDir(full)).toBe('non-empty');

    const file = join(dir, 'a-file');
    await writeFile(file, 'x', 'utf8');
    expect(await inspectDir(file)).toBe('file');
  });
});

describe('infra/store/projectFile · materializeProjectDir（自 init 分支迁移）', () => {
  const files = [
    { relPath: 'project.yaml', content: 'schema: 1\n' },
    { relPath: 'outline.md', content: '# o\n' },
    { relPath: 'scenes/.gitkeep', content: '' },
  ];

  it('目标缺失：整目录 rename，落盘后无 .sw-init-* 临时残留', async () => {
    const target = join(dir, 'proj');
    await materializeProjectDir(target, files, { dirState: 'missing', ensureDirs: ['exports'] });

    expect(await readFile(join(target, 'project.yaml'), 'utf8')).toBe('schema: 1\n');
    expect(await readdir(join(target, 'exports'))).toEqual([]);
    expect((await readdir(dir)).filter((name) => name.startsWith('.sw-init-'))).toEqual([]);
  });

  it('目标为既有空目录：逐顶层条目落位，同样无临时残留', async () => {
    const target = join(dir, 'proj');
    await mkdir(target);
    await materializeProjectDir(target, files, { dirState: 'empty', ensureDirs: ['exports'] });

    expect(await readFile(join(target, 'outline.md'), 'utf8')).toBe('# o\n');
    expect(await readdir(join(target, 'scenes'))).toEqual(['.gitkeep']);
    expect((await readdir(dir)).filter((name) => name.startsWith('.sw-init-'))).toEqual([]);
  });

  it('非空目录 + overwrite（--force）：覆盖同名脚手架文件，保留用户文件', async () => {
    const target = join(dir, 'proj');
    await mkdir(target);
    await writeFile(join(target, 'project.yaml'), '旧内容', 'utf8');
    await writeFile(join(target, 'notes.txt'), '用户笔记', 'utf8');

    await materializeProjectDir(target, files, { dirState: 'non-empty', ensureDirs: ['exports'] });

    expect(await readFile(join(target, 'project.yaml'), 'utf8')).toBe('schema: 1\n');
    expect(await readFile(join(target, 'notes.txt'), 'utf8')).toBe('用户笔记');
    // 迁移说明：原断言查 init 版临时名 `.tmp-`；engine 原子写原语的临时名含 `.tmp`，
    // 断言意图不变（落盘后零临时残留），匹配式放宽为包含 `.tmp`。
    expect((await readdir(target)).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
