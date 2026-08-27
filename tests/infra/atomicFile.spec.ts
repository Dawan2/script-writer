import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../../src/infra/store/atomicFile.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sw-atomic-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('infra/store/atomicFile', () => {
  it('写入新文件且内容完整', async () => {
    const target = join(dir, 'a.txt');
    await writeFileAtomic(target, 'hello');
    expect(await readFile(target, 'utf8')).toBe('hello');
  });

  it('原子替换已有文件', async () => {
    const target = join(dir, 'a.txt');
    await writeFile(target, '旧内容');
    await writeFileAtomic(target, '新内容');
    expect(await readFile(target, 'utf8')).toBe('新内容');
  });

  it('成功后目录内不留 .tmp 残骸（rename 事务收尾）', async () => {
    await writeFileAtomic(join(dir, 'a.txt'), 'x');
    await writeFileAtomic(join(dir, 'a.txt'), 'y');
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('目标目录不存在时报错，且不在别处留下临时文件', async () => {
    const missingDir = join(dir, 'no-such-dir');
    await expect(writeFileAtomic(join(missingDir, 'a.txt'), 'x')).rejects.toThrow();
    // 临时文件约定与目标同目录；父目录既不存在，此处必须保持不存在（无副作用）
    await expect(readdir(missingDir)).rejects.toThrow();
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('写失败（目标路径是目录）不破坏现场', async () => {
    const asDir = join(dir, '占位目录');
    await rm(asDir, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(asDir);
    await expect(writeFileAtomic(asDir, 'x')).rejects.toThrow();
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
