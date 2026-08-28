/**
 * 场文件适配器单测（SPEC-05 §3-7 归一 / §4.2-D2 编号判定 / §4.3 命名冻结）。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findSceneFileById,
  listSceneFiles,
  normalizeSceneId,
  writeSceneFile,
} from '../../src/infra/store/sceneFile.js';
import { SCENES_DIR } from '../../src/infra/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-scenefile-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('infra/store/sceneFile：normalizeSceneId（§3-7）', () => {
  it('1–3 位数字补零归一（10 ≡ 010）；4 位及以上原样', () => {
    expect(normalizeSceneId('1')).toBe('001');
    expect(normalizeSceneId('10')).toBe('010');
    expect(normalizeSceneId('010')).toBe('010');
    expect(normalizeSceneId('1000')).toBe('1000');
  });

  it('非法形态返回 null（字母 / 混合 / 空 / 负号）', () => {
    for (const bad of ['abc', '01a', '', '-1', '  ']) {
      expect(normalizeSceneId(bad)).toBeNull();
    }
  });
});

describe('infra/store/sceneFile：探测与原子写', () => {
  it('findSceneFileById 按编号判定不看 slug', async () => {
    await writeSceneFile(dir, '010-开场.md', '# 场 010\n');
    expect(await findSceneFileById(dir, '010')).toBe('010-开场.md');
    expect(await findSceneFileById(dir, '020')).toBeUndefined();
  });

  it('listSceneFiles 按文件名升序；scenes/ 缺失视为空', async () => {
    expect(await listSceneFiles(dir)).toEqual([]);
    await writeSceneFile(dir, '020-b.md', '');
    await writeSceneFile(dir, '010-a.md', '');
    await writeFile(join(dir, SCENES_DIR, 'notes.md'), 'not a scene');
    expect(await listSceneFiles(dir)).toEqual(['010-a.md', '020-b.md']);
  });

  it('writeSceneFile 自动重建缺失的 scenes/ 目录', async () => {
    await writeSceneFile(dir, '010-scene.md', '内容');
    expect(await findSceneFileById(dir, '010')).toBe('010-scene.md');
  });
});
