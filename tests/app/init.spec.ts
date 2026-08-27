import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SwError } from '../../src/app/errors/sw-error.js';
import {
  parseFormatAnswer,
  parseSceneCountAnswer,
  parseYesNoAnswer,
  planQuestions,
  runInitWorkflow,
  type InitDeps,
} from '../../src/app/workflow/init.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sw-init-app-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 可注入的脚本化交互（ready-tasks T04 风险项：向导必须可自动化测试）。 */
function scriptedDeps(answers: string[]): { deps: InitDeps; prompts: string[]; infos: string[] } {
  const prompts: string[] = [];
  const infos: string[] = [];
  let cursor = 0;
  const deps: InitDeps = {
    ask: (question) => {
      prompts.push(question);
      return Promise.resolve(answers[cursor++] ?? '');
    },
    info: (line) => {
      infos.push(line);
    },
    today: () => '2026-08-27',
  };
  return { deps, prompts, infos };
}

describe('app/workflow/init · planQuestions（SPEC-01：--yes 与旗标跳问）', () => {
  it('无旗标时恰好四问，顺序为 标题→类型→场数→AI（≤ 4 问红线）', () => {
    expect(planQuestions({})).toEqual(['title', 'format', 'expectedSceneCount', 'aiEnabled']);
  });

  it('--yes 跳过全部问题', () => {
    expect(planQuestions({ yes: true })).toEqual([]);
  });

  it('旗标提供的问题自动跳过（含 --no-ai 的 false 值）', () => {
    expect(planQuestions({ title: 't' })).toEqual(['format', 'expectedSceneCount', 'aiEnabled']);
    expect(planQuestions({ ai: false })).toEqual(['title', 'format', 'expectedSceneCount']);
    expect(planQuestions({ title: 't', format: 'podcast', scenes: 3, ai: true })).toEqual([]);
  });
});

describe('app/workflow/init · 答案解析（回车=默认，容错重问）', () => {
  it('parseFormatAnswer：空取默认；1..3 按 SCRIPT_FORMATS 序号；也认格式名；其余 null', () => {
    expect(parseFormatAnswer('', 'short-video')).toBe('short-video');
    expect(parseFormatAnswer('1', 'short-video')).toBe('screenplay');
    expect(parseFormatAnswer('3', 'short-video')).toBe('podcast');
    expect(parseFormatAnswer('podcast', 'short-video')).toBe('podcast');
    expect(parseFormatAnswer('4', 'short-video')).toBeNull();
    expect(parseFormatAnswer('novel', 'short-video')).toBeNull();
  });

  it('parseSceneCountAnswer：空取默认；正整数有效；0/负数/小数/非数 null', () => {
    expect(parseSceneCountAnswer('', 5)).toBe(5);
    expect(parseSceneCountAnswer('8', 5)).toBe(8);
    expect(parseSceneCountAnswer('0', 5)).toBeNull();
    expect(parseSceneCountAnswer('-2', 5)).toBeNull();
    expect(parseSceneCountAnswer('3.5', 5)).toBeNull();
    expect(parseSceneCountAnswer('abc', 5)).toBeNull();
  });

  it('parseYesNoAnswer：空取默认；y/yes/是 与 n/no/否；其余 null', () => {
    expect(parseYesNoAnswer('', false)).toBe(false);
    expect(parseYesNoAnswer('y', false)).toBe(true);
    expect(parseYesNoAnswer('是', false)).toBe(true);
    expect(parseYesNoAnswer('NO', true)).toBe(false);
    expect(parseYesNoAnswer('maybe', false)).toBeNull();
  });
});

describe('app/workflow/init · runInitWorkflow', () => {
  it('交互全答：四问按序、答案落入 project.yaml，模板渲染出标题', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'my-story');
    const { deps, prompts } = scriptedDeps(['我的短片', '1', '8', 'y']);

    const result = await runInitWorkflow(target, {}, deps);

    expect(prompts).toHaveLength(4);
    expect(result.questionsAsked).toEqual(['title', 'format', 'expectedSceneCount', 'aiEnabled']);
    expect(result.meta.title).toBe('我的短片');
    expect(result.meta.format).toBe('screenplay');
    expect(result.meta.expectedSceneCount).toBe(8);
    expect(result.meta.settings.ai.enabled).toBe(true);
    // screenplay 专属模板随 W1-P1-T07 交付，当前回退通用骨架
    expect(result.templateId).toBe('short-video');
    expect(result.templateFallback).toBe(true);

    const outline = await readFile(path.join(target, 'outline.md'), 'utf8');
    expect(outline).toContain('# 我的短片 · 大纲');
    expect(outline).toContain('预计 8 场');
  });

  it('无法识别的输入重问同一问题，问题总数仍为 4 问（SPEC-01 ≤ 4 问红线）', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'p');
    const { deps, infos } = scriptedDeps(['', 'x', 'podcast', '0', '7', 'maybe', 'n']);

    const result = await runInitWorkflow(target, {}, deps);

    expect(result.questionsAsked).toHaveLength(4);
    expect(infos.filter((line) => line.includes('无法识别'))).toHaveLength(3);
    expect(result.meta.title).toBe('p');
    expect(result.meta.format).toBe('podcast');
    expect(result.meta.expectedSceneCount).toBe(7);
    expect(result.meta.settings.ai.enabled).toBe(false);
  });

  it('--yes：零交互，默认值显式落盘（标题=目录名、short-video、5 场、AI 关——GAP-03）', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'my-story');
    const { deps, prompts } = scriptedDeps([]);

    const result = await runInitWorkflow(target, { yes: true }, deps);

    expect(prompts).toHaveLength(0);
    expect(result.meta.title).toBe('my-story');
    expect(result.meta.format).toBe('short-video');
    expect(result.meta.expectedSceneCount).toBe(5);
    expect(result.meta.settings.ai.enabled).toBe(false);

    const yaml = await readFile(path.join(target, 'project.yaml'), 'utf8');
    expect(yaml).toContain('expectedSceneCount: 5');
  });

  it('产出目录布局与 P1 §6.1 一致：project.yaml + outline.md + characters/ + scenes/ + exports/', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'layout');
    const { deps } = scriptedDeps([]);

    await runInitWorkflow(target, { yes: true }, deps);

    const entries = (await readdir(target)).sort();
    expect(entries).toEqual(['.gitignore', 'characters', 'exports', 'outline.md', 'project.yaml', 'scenes']);
  });

  it('目标目录非空且无 --force：抛 SW-E010，三段式含 --force 提示，现场不被破坏', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'busy');
    await mkdir(target);
    await writeFile(path.join(target, 'draft.txt'), '既有内容', 'utf8');
    const { deps } = scriptedDeps([]);

    const error = await runInitWorkflow(target, { yes: true }, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SwError);
    expect((error as SwError).code).toBe('SW-E010');
    expect((error as SwError).how).toContain('--force');
    expect(await readFile(path.join(target, 'draft.txt'), 'utf8')).toBe('既有内容');
    expect((await readdir(target)).sort()).toEqual(['draft.txt']);
  });

  it('目标路径是文件：同样报 SW-E010 且不动现场', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'a-file');
    await writeFile(target, 'x', 'utf8');
    const { deps } = scriptedDeps([]);

    const error = await runInitWorkflow(target, { yes: true }, deps).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SwError);
    expect((error as SwError).code).toBe('SW-E010');
    expect(await readFile(target, 'utf8')).toBe('x');
  });

  it('重复 init 幂等报错：第二次 SW-E010，project.yaml 字节不变', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'again');
    const { deps } = scriptedDeps([]);
    await runInitWorkflow(target, { yes: true }, deps);
    const firstYaml = await readFile(path.join(target, 'project.yaml'), 'utf8');

    const error = await runInitWorkflow(target, { yes: true, title: '换标题' }, deps).catch(
      (e: unknown) => e,
    );

    expect((error as SwError).code).toBe('SW-E010');
    expect(await readFile(path.join(target, 'project.yaml'), 'utf8')).toBe(firstYaml);
  });

  it('--force：非空目录重写脚手架文件，保留用户既有文件', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'forced');
    await mkdir(target);
    await writeFile(path.join(target, 'notes.txt'), '用户笔记', 'utf8');
    const { deps } = scriptedDeps([]);

    await runInitWorkflow(target, { yes: true, force: true }, deps);

    expect(await readFile(path.join(target, 'notes.txt'), 'utf8')).toBe('用户笔记');
    expect(await readFile(path.join(target, 'project.yaml'), 'utf8')).toContain('schema: 1');
  });

  it('既有空目录可直接初始化（空态不算 SW-E010）', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'empty-dir');
    await mkdir(target);
    const { deps } = scriptedDeps([]);

    await runInitWorkflow(target, { yes: true }, deps);

    expect(await readFile(path.join(target, 'project.yaml'), 'utf8')).toContain('title: "empty-dir"');
  });

  it('--template 指向不存在的模板：SW-E031 且附可用模板列表', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'tpl');
    const { deps } = scriptedDeps([]);

    const error = await runInitWorkflow(target, { yes: true, template: 'nope' }, deps).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SwError);
    expect((error as SwError).code).toBe('SW-E031');
    expect((error as SwError).how).toContain('short-video');
  });

  it('--template short-video 显式指定：不回退，format 独立生效', async () => {
    const root = await makeTempRoot();
    const target = path.join(root, 'tpl-ok');
    const { deps } = scriptedDeps([]);

    const result = await runInitWorkflow(
      target,
      { yes: true, template: 'short-video', format: 'podcast' },
      deps,
    );

    expect(result.templateId).toBe('short-video');
    expect(result.templateFallback).toBe(false);
    expect(result.meta.format).toBe('podcast');
  });
});
