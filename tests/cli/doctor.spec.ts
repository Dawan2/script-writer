import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import type { CliIo } from '../../src/cli/io.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sw-doctor-cli-'));
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

function makeIo(): TestIo {
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
    io: { stdin: Readable.from([]), stdout: collect(outChunks), stderr: collect(errChunks) },
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join(''),
  };
}

function argv(...args: string[]): string[] {
  return ['node', 'sw', ...args];
}

/** 健康项目夹具：真实走 `sw init --yes`。 */
async function makeHealthyProject(): Promise<string> {
  const root = await makeTempRoot();
  const target = path.join(root, 'proj');
  const t = makeIo();
  expect(await runCli(argv('init', target, '--yes'), t.io)).toBe(0);
  return target;
}

describe('cli · sw doctor 健康项目（验收①：全绿退出码 0）', () => {
  it('零红项：退出码 0，报告含逐项绿勾、锁「未实现」跳过与结论行，stderr 为空', async () => {
    const target = await makeHealthyProject();
    const t = makeIo();

    const code = await runCli(argv('doctor', target), t.io);

    expect(code).toBe(0);
    const out = t.stdout();
    expect(out).toContain(`sw doctor · 项目自检：${target}`);
    for (const title of ['✔ 运行时版本', '✔ 项目文件', '✔ 元数据 schema', '✔ 目录布局', '✔ 场景一致性', '✔ AI key']) {
      expect(out).toContain(title);
    }
    expect(out).toContain('○ 项目锁：未实现');
    expect(out).toContain('/ 0 红 /');
    expect(out).toContain('结论：');
    expect(out).not.toContain('修复：');
    expect(t.stderr()).toBe('');
  });
});

describe('cli · sw doctor 三类人为损坏（验收②：红项含修复命令；验收③：退出码 1）', () => {
  it('损坏①删 project.yaml：退出码 1，红项附 sw init 修复命令，stderr 三段式 SW-E013', async () => {
    const target = await makeHealthyProject();
    await rm(path.join(target, 'project.yaml'));
    const t = makeIo();

    const code = await runCli(argv('doctor', target), t.io);

    expect(code).toBe(1);
    const out = t.stdout();
    expect(out).toContain('✖ 项目文件');
    expect(out).toContain('修复：');
    expect(out).toContain('sw init');
    expect(t.stderr()).toContain('✖ SW-E013');
    expect(t.stderr()).toContain('原因：');
    expect(t.stderr()).toContain('怎么办：');
    expect(t.stderr()).toContain(`sw doctor ${target}`);
  });

  it('损坏②改坏 schema：退出码 1，红项指明期望/实际并附修复命令', async () => {
    const target = await makeHealthyProject();
    const yamlPath = path.join(target, 'project.yaml');
    const yaml = await readFile(yamlPath, 'utf8');
    await writeFile(yamlPath, yaml.replace('schema: 1', 'schema: 9'), 'utf8');
    const t = makeIo();

    const code = await runCli(argv('doctor', target), t.io);

    expect(code).toBe(1);
    const out = t.stdout();
    expect(out).toContain('✖ 元数据 schema');
    expect(out).toContain('期望 1，实际 9');
    expect(out).toContain('修复：');
    expect(t.stderr()).toContain('SW-E013');
  });

  it('损坏③scenes_done 与磁盘不符：退出码 1，红项列缺失编号并附修复指引', async () => {
    const target = await makeHealthyProject();
    const yamlPath = path.join(target, 'project.yaml');
    const yaml = await readFile(yamlPath, 'utf8');
    await writeFile(yamlPath, yaml.replace('scenes_done: []', 'scenes_done: ["003"]'), 'utf8');
    const t = makeIo();

    const code = await runCli(argv('doctor', target), t.io);

    expect(code).toBe(1);
    const out = t.stdout();
    expect(out).toContain('✖ 场景一致性');
    expect(out).toContain('003');
    expect(out).toContain('修复：');
    expect(out).toContain('scenes_done');
  });

  it('多个红项同时呈现：报告逐项列出，结论计数正确', async () => {
    const target = await makeHealthyProject();
    await rm(path.join(target, 'project.yaml'));
    await rm(path.join(target, 'exports'), { recursive: true });
    const t = makeIo();

    const code = await runCli(argv('doctor', target), t.io);

    expect(code).toBe(1);
    const out = t.stdout();
    expect(out).toContain('✖ 项目文件');
    expect(out).toContain('✖ 目录布局');
    expect(out).toContain('/ 2 红 /');
    expect(t.stderr()).toContain('项目文件、目录布局');
  });

  it('对空目录/非项目目录运行：完整报告 + 退出码 1，不崩溃', async () => {
    const root = await makeTempRoot();
    const t = makeIo();

    const code = await runCli(argv('doctor', root), t.io);

    expect(code).toBe(1);
    expect(t.stdout()).toContain('✖ 项目文件');
    expect(t.stdout()).toContain('结论：');
    expect(t.stderr()).not.toContain('未预期错误');
  });
});

describe('cli · sw doctor 帮助与可发现性', () => {
  it('sw doctor --help 退出码 0 且含 ≥1 条可复制示例与退出码说明', async () => {
    const t = makeIo();
    expect(await runCli(argv('doctor', '--help'), t.io)).toBe(0);
    expect(t.stdout()).toContain('sw doctor my-story');
    expect(t.stdout()).toContain('退出码');
  });

  it('根 --help 路线图标注 doctor 已可用（诚实进度）', async () => {
    const t = makeIo();
    await runCli(argv('--help'), t.io);
    expect(t.stdout()).toContain('[可用 · W1-P1-T08]');
  });
});
