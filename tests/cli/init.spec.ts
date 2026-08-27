import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import type { CliIo } from '../../src/cli/io.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sw-init-cli-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface TestIo {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
}

/** 可注入 stdin 的测试 IO：stdinText 为空即模拟"无输入/EOF"（CI 场景）。 */
function makeIo(stdinText = ''): TestIo {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const collect = (sink: string[]) =>
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        sink.push(chunk.toString());
        callback();
      },
    });
  return {
    io: {
      stdin: Readable.from(stdinText === '' ? [] : [stdinText]),
      stdout: collect(outChunks),
      stderr: collect(errChunks),
    },
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join(''),
  };
}

function argv(...args: string[]): string[] {
  return ['node', 'sw', ...args];
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('cli · sw init --yes（非交互路径，SPEC-01 验收"零交互跑通"）', () => {
  it('退出码 0，产出完整布局与逐字节可断言的 project.yaml', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'my-story');
    const t = makeIo();
    const before = isoToday();

    const code = await runCli(argv('init', target, '--yes'), t.io);
    const after = isoToday();

    expect(code).toBe(0);
    expect(t.stdout()).toContain('✔ 项目已创建');
    expect(t.stdout()).not.toContain('? ①'); // 零交互：无任何提问
    expect((await readdir(target)).sort()).toEqual([
      '.gitignore',
      'characters',
      'exports',
      'outline.md',
      'project.yaml',
      'scenes',
    ]);

    const yaml = await readFile(path.join(target, 'project.yaml'), 'utf8');
    const expectedFor = (created: string) =>
      [
        'schema: 1',
        'title: "my-story"',
        'format: short-video',
        `created: ${created}`,
        'expectedSceneCount: 5',
        'settings:',
        '  ai: { enabled: false, provider: null }',
        '  export: { default: markdown }',
        'progress:',
        '  step: outline',
        '  scenes_done: []',
        '',
      ].join('\n');
    expect([expectedFor(before), expectedFor(after)]).toContain(yaml);
  });

  it('摘要含下一步引导且不虚假承诺未实现命令（标注 W1-P1-T05）', async () => {
    const root = await makeTempRoot();
    const t = makeIo();

    const code = await runCli(argv('init', path.join(root, 'p'), '--yes'), t.io);

    expect(code).toBe(0);
    expect(t.stdout()).toContain('下一步');
    expect(t.stdout()).toContain('W1-P1-T05');
  });
});

describe('cli · sw init 交互路径（管道注入 stdin）', () => {
  it('依次回答四问：答案生效，提问恰好 4 次', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'wizard');
    const t = makeIo('我的短片\n3\n8\ny\n');

    const code = await runCli(argv('init', target), t.io);

    expect(code).toBe(0);
    for (const marker of ['? ①', '? ②', '? ③', '? ④']) {
      expect(t.stdout()).toContain(marker);
    }
    const yaml = await readFile(path.join(target, 'project.yaml'), 'utf8');
    expect(yaml).toContain('title: "我的短片"');
    expect(yaml).toContain('format: podcast');
    expect(yaml).toContain('expectedSceneCount: 8');
    expect(yaml).toContain('ai: { enabled: true, provider: null }');
  });

  it('每问回车即接受默认值（SPEC-01：回车即接受）', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'defaults');
    const t = makeIo('\n\n\n\n');

    const code = await runCli(argv('init', target), t.io);

    expect(code).toBe(0);
    const yaml = await readFile(path.join(target, 'project.yaml'), 'utf8');
    expect(yaml).toContain('title: "defaults"');
    expect(yaml).toContain('format: short-video');
    expect(yaml).toContain('expectedSceneCount: 5');
    expect(yaml).toContain('ai: { enabled: false, provider: null }');
  });

  it('stdin 直接 EOF（无 --yes 的管道空输入）：全部取默认值而非挂起', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'eof');
    const t = makeIo();

    const code = await runCli(argv('init', target), t.io);

    expect(code).toBe(0);
    expect(await readFile(path.join(target, 'project.yaml'), 'utf8')).toContain('title: "eof"');
  });

  it('旗标提供的问题自动跳过：--title 后只剩三问', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'skip');
    const t = makeIo('\n\n\n');

    const code = await runCli(argv('init', target, '--title', '定制标题'), t.io);

    expect(code).toBe(0);
    expect(t.stdout()).not.toContain('? ①');
    expect(t.stdout()).toContain('? ②');
    expect(await readFile(path.join(target, 'project.yaml'), 'utf8')).toContain('title: "定制标题"');
  });
});

describe('cli · sw init 错态与退出码（GAP-06 SPEC-03-EXT：0/1/2）', () => {
  it('目标目录非空且无 --force：退出码 1，stderr 三段式 SW-E010，现场不破坏', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'busy');
    await mkdir(target);
    await writeFile(path.join(target, 'keep.txt'), '既有', 'utf8');
    const t = makeIo();

    const code = await runCli(argv('init', target, '--yes'), t.io);

    expect(code).toBe(1);
    expect(t.stderr()).toContain('✖ SW-E010');
    expect(t.stderr()).toContain('原因：');
    expect(t.stderr()).toContain('怎么办：');
    expect(t.stderr()).toContain('--force');
    expect((await readdir(target)).sort()).toEqual(['keep.txt']);
    expect((await readdir(root)).filter((name) => name.startsWith('.sw-init-'))).toEqual([]);
  });

  it('--force 覆盖非空目录：退出码 0，用户文件保留', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'forced');
    await mkdir(target);
    await writeFile(path.join(target, 'keep.txt'), '既有', 'utf8');
    const t = makeIo();

    const code = await runCli(argv('init', target, '--yes', '--force'), t.io);

    expect(code).toBe(0);
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('既有');
    expect(await readFile(path.join(target, 'project.yaml'), 'utf8')).toContain('schema: 1');
  });

  it('未知 --template：退出码 1（SW-E031，运行期输入校验错误）', async () => {
    const root = await makeTempRoot();
    const t = makeIo();

    const code = await runCli(argv('init', path.join(root, 'x'), '--yes', '--template', 'nope'), t.io);

    expect(code).toBe(1);
    expect(t.stderr()).toContain('SW-E031');
  });

  it('非法 --format 取值：用法错误退出码 2，且无任何落盘副作用', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'bad-format');
    const t = makeIo();

    const code = await runCli(argv('init', target, '--yes', '--format', 'novel'), t.io);

    expect(code).toBe(2);
    expect((await readdir(root)).sort()).toEqual([]); // 未进入业务逻辑：目录未创建
  });

  it('非法 --scenes 取值（0 / 非数字）：用法错误退出码 2', async () => {
    const root = await makeTempRoot();
    const t = makeIo();
    expect(await runCli(argv('init', path.join(root, 'a'), '--yes', '--scenes', '0'), t.io)).toBe(2);
    expect(await runCli(argv('init', path.join(root, 'b'), '--yes', '--scenes', 'abc'), makeIo().io)).toBe(2);
  });

  it('未知旗标：用法错误退出码 2', async () => {
    const t = makeIo();
    expect(await runCli(argv('init', '--bogus'), t.io)).toBe(2);
  });
});

describe('cli · 帮助与版本的退出码（GAP-06：正常终止为 0）', () => {
  it('sw --help / sw --version / sw init --help 均退出码 0', async () => {
    expect(await runCli(argv('--help'), makeIo().io)).toBe(0);
    expect(await runCli(argv('--version'), makeIo().io)).toBe(0);
    expect(await runCli(argv('init', '--help'), makeIo().io)).toBe(0);
  });

  it('sw init --help 含 ≥1 条可复制示例（P1 §4 命令可发现性）', async () => {
    const t = makeIo();
    await runCli(argv('init', '--help'), t.io);
    expect(t.stdout()).toContain('sw init my-story --yes');
  });

  it('根 --help 的路线图标注 init 已可用、其余仍规划中（诚实进度）', async () => {
    const t = makeIo();
    await runCli(argv('--help'), t.io);
    expect(t.stdout()).toContain('[可用 · W1-P1-T04]');
    expect(t.stdout()).toContain('规划中');
  });
});
