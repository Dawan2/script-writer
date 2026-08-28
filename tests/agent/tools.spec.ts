/**
 * 工具注册表 + 首批只读工具测试（TASK-P3-05）。
 * E3：注册表拒载非法描述；三工具对测试剧本夹具返回正确结果；F2 前置校验生效。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '../../src/agent/tools/builtin.js';
import { createToolRegistry, validateArgs } from '../../src/agent/tools/registry.js';
import { ToolRegistryError, type Tool } from '../../src/agent/tools/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-tools-'));
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  mkdirSync(join(dir, 'characters'), { recursive: true });
  writeFileSync(join(dir, 'scenes/010-opening.md'), '# 010 开场\n\n雨夜，电话铃响。\n');
  writeFileSync(join(dir, 'scenes/020-street.md'), '# 020 街头\n\n主角冲进雨里。\n');
  writeFileSync(join(dir, 'characters/李梅.md'), '# 李梅\n\n主角，28 岁，记者。\n');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const registry = () => createToolRegistry(BUILTIN_TOOLS);

describe('agent/tools：注册表校验（拒载矩阵）', () => {
  const validTool = (over: Partial<Tool['desc']> = {}): Tool => ({
    desc: {
      name: 'demo_tool',
      version: '1',
      description: '演示工具。用于测试注册校验。',
      params: {},
      sideEffect: 'none',
      preconditions: [],
      failureModes: ['DEMO_FAIL'],
      costHint: 'cheap',
      ...over,
    },
    handler: async () => ({}),
  });

  it('首批三工具注册成功，描述齐备（side_effect=none，失败码枚举非空）', () => {
    const reg = registry();
    expect(reg.descriptions.map((d) => d.name).sort()).toEqual([
      'get_bible_entry',
      'list_scenes',
      'read_scene',
    ]);
    for (const d of reg.descriptions) {
      expect(d.sideEffect).toBe('none');
      expect(d.failureModes.length).toBeGreaterThan(0);
      expect(d.description).toContain('用于');
    }
  });

  it.each([
    ['坏 name', validTool({ name: 'Bad-Name' }), 'bad-name'],
    ['description 缺「用于」', validTool({ description: '只是个工具。' }), 'bad-description'],
    ['destructive 拒载（P-3）', validTool({ sideEffect: 'destructive' }), 'bad-side-effect'],
    ['failure_modes 空', validTool({ failureModes: [] }), 'bad-failure-modes'],
    [
      'params desc 空',
      validTool({ params: { x: { type: 'string', required: true, desc: '' } } }),
      'bad-params',
    ],
  ])('%s → 拒载', (_label, tool, reason) => {
    expect(() => createToolRegistry([tool])).toThrowError(
      expect.objectContaining({ name: 'ToolRegistryError', reason }) as ToolRegistryError,
    );
  });

  it('重名工具拒载（duplicate-tool）', () => {
    expect(() => createToolRegistry([validTool(), validTool()])).toThrowError(
      expect.objectContaining({ reason: 'duplicate-tool' }) as ToolRegistryError,
    );
  });
});

describe('agent/tools：F2 前置参数校验', () => {
  const desc = BUILTIN_TOOLS[0]?.desc;
  it('未知参数 / 缺必填 / 类型错 三码生效，不进 handler', async () => {
    const reg = registry();
    await expect(reg.call('read_scene', { projectDir: dir }, { ghost: 'x' })).rejects.toMatchObject({
      code: 'TOOL_ARG_UNKNOWN',
    });
    await expect(reg.call('read_scene', { projectDir: dir })).rejects.toMatchObject({
      code: 'TOOL_ARG_MISSING',
    });
    await expect(
      reg.call('read_scene', { projectDir: dir }, { scene_id: 123 }),
    ).rejects.toMatchObject({ code: 'TOOL_ARG_TYPE' });
  });

  it('validateArgs 单元：合法返回 null', () => {
    expect(desc).toBeDefined();
    if (desc === undefined) return;
    expect(validateArgs(desc, { scene_id: '010' })).toBeNull();
  });

  it('未注册工具 → TOOL_NOT_FOUND（附可用清单）', async () => {
    await expect(registry().call('nope', { projectDir: dir })).rejects.toMatchObject({
      name: 'ToolCallError',
      code: 'TOOL_NOT_FOUND',
    });
  });
});

describe('agent/tools：首批只读工具（E3 夹具断言）', () => {
  it('read_scene：场号归一（10≡010）后返回全文与文件名', async () => {
    const out = (await registry().call('read_scene', { projectDir: dir }, { scene_id: '10' })) as {
      scene_id: string;
      file: string;
      content: string;
    };
    expect(out.scene_id).toBe('010');
    expect(out.file).toBe('010-opening.md');
    expect(out.content).toContain('雨夜');
  });

  it('read_scene：不存在 → SCENE_NOT_FOUND；非法场号 → SCENE_ID_INVALID', async () => {
    await expect(
      registry().call('read_scene', { projectDir: dir }, { scene_id: '999' }),
    ).rejects.toMatchObject({ code: 'SCENE_NOT_FOUND' });
    await expect(
      registry().call('read_scene', { projectDir: dir }, { scene_id: 'abc' }),
    ).rejects.toMatchObject({ code: 'SCENE_ID_INVALID' });
  });

  it('list_scenes：升序列出场号与 slug', async () => {
    const out = (await registry().call('list_scenes', { projectDir: dir })) as {
      scene_id: string;
      slug: string;
    }[];
    expect(out.map((s) => s.scene_id)).toEqual(['010', '020']);
    expect(out[0]?.slug).toBe('opening');
  });

  it('get_bible_entry：characters/ 命中；story-bible/ 优先；不存在 → ENTRY_NOT_FOUND；路径穿越拦截', async () => {
    const reg = registry();
    const out = (await reg.call('get_bible_entry', { projectDir: dir }, { name: '李梅' })) as {
      path: string;
      content: string;
    };
    expect(out.path).toBe('characters/李梅.md');
    expect(out.content).toContain('记者');

    mkdirSync(join(dir, 'story-bible'), { recursive: true });
    writeFileSync(join(dir, 'story-bible/李梅.md'), '# 李梅（设定集版）');
    const out2 = (await reg.call('get_bible_entry', { projectDir: dir }, { name: '李梅' })) as {
      path: string;
      content: string;
    };
    expect(out2.path).toBe('story-bible/李梅.md');

    await expect(reg.call('get_bible_entry', { projectDir: dir }, { name: 'nobody' })).rejects.toMatchObject({
      code: 'ENTRY_NOT_FOUND',
    });
    await expect(
      reg.call('get_bible_entry', { projectDir: dir }, { name: '../secrets' }),
    ).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' });
  });
});
