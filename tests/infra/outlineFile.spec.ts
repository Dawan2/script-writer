import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectOutlineFile, writeOutlineFile } from '../../src/infra/store/outlineFile.js';
import { OUTLINE_FILE } from '../../src/infra/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-outline-file-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('infra/store/outlineFile：三态探测', () => {
  it('outline.md 缺失 → exists: false', async () => {
    expect(await inspectOutlineFile(dir)).toEqual({ exists: false });
  });

  it('目录本身不存在 → exists: false（ENOTDIR/ENOENT 归一为缺失）', async () => {
    expect(await inspectOutlineFile(join(dir, 'no-such-dir'))).toEqual({ exists: false });
  });

  it('0 字节或仅空白 → blank: true（SPEC-02"为空"语义，可写骨架不算覆盖）', async () => {
    await writeFile(join(dir, OUTLINE_FILE), '');
    expect(await inspectOutlineFile(dir)).toEqual({ exists: true, blank: true });
    await writeFile(join(dir, OUTLINE_FILE), '  \n\t\n');
    expect(await inspectOutlineFile(dir)).toEqual({ exists: true, blank: true });
  });

  it('有内容 → blank: false', async () => {
    await writeFile(join(dir, OUTLINE_FILE), '# 大纲\n010 开场\n');
    expect(await inspectOutlineFile(dir)).toEqual({ exists: true, blank: false });
  });
});

describe('infra/store/outlineFile：原子写', () => {
  it('写入后内容一致，且目录不留 .tmp 残骸', async () => {
    await writeOutlineFile(dir, '# 骨架\n');
    expect(await readFile(join(dir, OUTLINE_FILE), 'utf8')).toBe('# 骨架\n');
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('对既有文件原子替换（rename 语义：只有旧/新两态）', async () => {
    await writeFile(join(dir, OUTLINE_FILE), '旧内容');
    await writeOutlineFile(dir, '新内容');
    expect(await readFile(join(dir, OUTLINE_FILE), 'utf8')).toBe('新内容');
  });
});
