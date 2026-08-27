import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProjectMeta } from '../../src/core/model/project.js';
import { parseProjectMeta } from '../../src/core/model/parseProject.js';
import {
  readProjectFileRaw,
  scanProjectDisk,
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
