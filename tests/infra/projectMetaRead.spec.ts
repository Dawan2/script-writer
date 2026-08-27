import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectMeta, type ProjectMeta } from '../../src/core/model/project.js';
import { serializeProjectMeta } from '../../src/infra/store/projectFile.js';
import { parseProjectMetaText, readProjectMetaFile } from '../../src/infra/store/projectMetaRead.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sw-meta-read-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('infra/projectMetaRead · parseProjectMetaText（serializeProjectMeta 子集往返）', () => {
  it('默认元数据（无 expectedSceneCount）往返：结构逐字段一致', () => {
    const meta = createProjectMeta({ title: 'my-story', created: '2026-08-27' });
    const outcome = parseProjectMetaText(serializeProjectMeta(meta));

    expect(outcome).toEqual({
      ok: true,
      raw: {
        schema: 1,
        title: 'my-story',
        format: 'short-video',
        created: '2026-08-27',
        settings: {
          ai: { enabled: false, provider: null },
          export: { default: 'markdown' },
        },
        progress: { step: 'outline', scenes_done: [] },
      },
    });
  });

  it('含 expectedSceneCount / AI 开 / provider 字符串 / 非空 scenes_done 的往返', () => {
    const meta: ProjectMeta = {
      ...createProjectMeta({
        title: '我的短片',
        format: 'podcast',
        created: '2026-08-27',
        expectedSceneCount: 8,
        aiEnabled: true,
      }),
    };
    meta.settings.ai.provider = 'openai';
    meta.progress.scenesDone = ['001', '002'];

    const outcome = parseProjectMetaText(serializeProjectMeta(meta));

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.raw.title).toBe('我的短片');
      expect(outcome.raw.expectedSceneCount).toBe(8);
      expect(outcome.raw.settings).toEqual({
        ai: { enabled: true, provider: 'openai' },
        export: { default: 'markdown' },
      });
      expect(outcome.raw.progress).toEqual({ step: 'outline', scenes_done: ['001', '002'] });
    }
  });

  it('容忍空行与整行注释（用户手工编辑场景）', () => {
    const text = [
      '# 手工注释',
      '',
      'schema: 1',
      'title: "t"',
      '',
      '  # 缩进注释',
      'progress:',
      '  step: outline',
      '  scenes_done: []',
      '',
    ].join('\n');

    const outcome = parseProjectMetaText(text);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.raw.schema).toBe(1);
      expect(outcome.raw.progress).toEqual({ step: 'outline', scenes_done: [] });
    }
  });

  it('字符串值内的逗号与转义引号不破坏 inline map/array 切分', () => {
    const text = ['settings:', '  ai: { enabled: true, provider: "a, \\"b\\"" }', 'list: ["x, y", "z"]', ''].join('\n');

    const outcome = parseProjectMetaText(text);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.raw.settings).toEqual({ ai: { enabled: true, provider: 'a, "b"' } });
      expect(outcome.raw.list).toEqual(['x, y', 'z']);
    }
  });

  it('解析失败返回结构化原因（含行号），不抛异常', () => {
    const cases: Array<[string, string]> = [
      ['这不是键值行', '第 1 行无法识别'],
      ['schema: 1\n  step: outline', '第 2 行缩进无所属小节'],
      ['progress:\n  sub:\n', '超出两级缩进子集'],
      ['schema: 1\n   bad: 1', '缩进必须是 0 或 2 个空格'],
      ['title: "未闭合', '字符串标量非法'],
      ['settings:\n  ai: { enabled: true', 'inline map 未闭合'],
      ['progress:\n  scenes_done: ["001"', 'inline array 未闭合'],
    ];
    for (const [text, expected] of cases) {
      const outcome = parseProjectMetaText(text);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toContain(expected);
      }
    }
  });
});

describe('infra/projectMetaRead · readProjectMetaFile（四态）', () => {
  it('目录无 project.yaml → missing；目录本身不存在 → missing', async () => {
    const root = await makeTempRoot();
    expect(await readProjectMetaFile(root)).toEqual({ state: 'missing' });
    expect(await readProjectMetaFile(path.join(root, '不存在'))).toEqual({ state: 'missing' });
  });

  it('project.yaml 被同名目录占用 → not-file', async () => {
    const root = await makeTempRoot();
    await mkdir(path.join(root, 'project.yaml'));
    expect(await readProjectMetaFile(root)).toEqual({ state: 'not-file' });
  });

  it('合法文件 → parsed（含原始结构）', async () => {
    const root = await makeTempRoot();
    const meta = createProjectMeta({ title: 't', created: '2026-08-27' });
    await writeFile(path.join(root, 'project.yaml'), serializeProjectMeta(meta), 'utf8');

    const outcome = await readProjectMetaFile(root);

    expect(outcome.state).toBe('parsed');
    if (outcome.state === 'parsed') {
      expect(outcome.raw.title).toBe('t');
    }
  });

  it('无法解析的文件 → invalid（含原因），不抛异常', async () => {
    const root = await makeTempRoot();
    await writeFile(path.join(root, 'project.yaml'), '{{{ 不是 yaml', 'utf8');

    const outcome = await readProjectMetaFile(root);

    expect(outcome.state).toBe('invalid');
    if (outcome.state === 'invalid') {
      expect(outcome.reason).toContain('第 1 行');
    }
  });
});
