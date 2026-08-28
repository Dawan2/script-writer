/**
 * `sw doctor` 应用层验收（W1-P1-T08 验收 ①②③ 的工作流层断言；
 * 移植自 `cursor/w3-doctor-3e3d` tests/app/diagnostics.spec.ts，
 * 校验内核断言按 parseProjectMeta 严格校验的实际文案迁移——断言迁移不删除）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCTOR_CHECKS,
  LOCK_FILE,
  REQUIRED_NODE_MAJOR,
  type DoctorCheck,
  type DoctorContext,
} from '../../src/app/diagnostics/checks.js';
import { runDoctorWorkflow } from '../../src/app/diagnostics/doctor.js';
import { validateProjectMeta } from '../../src/app/diagnostics/validate.js';
import { initProject } from '../../src/app/workflow/engine.js';
import { writeOutlineFile } from '../../src/infra/store/outlineFile.js';
import { createProjectMeta } from '../../src/core/model/project.js';
import { toProjectFileShape } from '../../src/core/model/parseProject.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sw-doctor-app-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 健康项目夹具：引擎物化 + 大纲就位（与 SPEC-01 布局一致）。 */
async function makeHealthyProject(): Promise<string> {
  const root = await makeTempRoot();
  const target = path.join(root, 'proj');
  const result = await initProject(target, { title: '自检片', created: '2026-08-27' });
  expect(result.ok).toBe(true);
  await writeOutlineFile(target, '# 大纲\n010 开场\n');
  return target;
}

/** 健康 project.yaml 的数据体（磁盘形态，供畸形变体改造）。 */
function healthyShape(): Record<string, unknown> {
  return toProjectFileShape(
    createProjectMeta({ title: 't', created: '2026-08-27', expectedSceneCount: 5 }),
  ) as unknown as Record<string, unknown>;
}

const doctorDeps = { nodeVersion: () => process.version };

function findCheck(id: string): DoctorCheck {
  const check = DOCTOR_CHECKS.find((item) => item.id === id);
  if (!check) {
    throw new Error(`检查项不存在：${id}`);
  }
  return check;
}

function makeCtx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    dir: '/nonexistent',
    nodeVersion: 'v22.0.0',
    projectFile: { state: 'missing' },
    findings: null,
    ...overrides,
  };
}

describe('app/diagnostics/validate · 字段级校验（引擎 parseProjectMeta 消费侧）', () => {
  it('健康 project.yaml：零问题，并给出下游视图（scenesDone/aiEnabled）', () => {
    const findings = validateProjectMeta(healthyShape());
    expect(findings.issues).toEqual([]);
    expect(findings.scenesDone).toEqual([]);
    expect(findings.aiEnabled).toBe(false);
  });

  it('schema 版本不符（验收②「改坏 schema」内核）：问题指明期望与实际', () => {
    const shape = healthyShape();
    shape['schema'] = 2;
    const findings = validateProjectMeta(shape);
    expect(findings.issues).toEqual(['schema 版本不符（期望 1，实际 2）']);
    expect(findings.scenesDone).toBeNull();
  });

  it('title / format / created / expectedSceneCount 逐条入 issues（不首错即停）', () => {
    const shape = healthyShape();
    shape['title'] = '';
    shape['format'] = 'novel';
    shape['created'] = '2026/08/27';
    shape['expectedSceneCount'] = 0;
    const { issues } = validateProjectMeta(shape);
    expect(issues).toContain('title 必须是非空字符串');
    expect(issues.some((issue) => issue.startsWith('format 必须是'))).toBe(true);
    expect(issues).toContain('created 必须是 ISO 日期（YYYY-MM-DD）');
    expect(issues.some((issue) => issue.startsWith('expectedSceneCount 必须是正整数'))).toBe(true);
  });

  it('expectedSceneCount 可选：字段缺失不报问题（GAP-03 旧式文件可读）', () => {
    const shape = healthyShape();
    delete shape['expectedSceneCount'];
    expect(validateProjectMeta(shape).issues).toEqual([]);
  });

  it('settings.ai 结构非法时入 issues 且 aiEnabled 视图为 null', () => {
    const shape = healthyShape();
    shape['settings'] = { ai: { enabled: 'yes', provider: null }, export: { default: '' } };
    const findings = validateProjectMeta(shape);
    expect(findings.issues.some((issue) => issue.startsWith('settings.ai'))).toBe(true);
    expect(findings.aiEnabled).toBeNull();
  });

  it('progress.step / scenes_done 非法时入 issues 且 scenesDone 视图为 null', () => {
    const shape = healthyShape();
    shape['progress'] = { step: 'flying', scenes_done: 'nope' };
    const findings = validateProjectMeta(shape);
    expect(findings.issues.some((issue) => issue.startsWith('progress.step'))).toBe(true);
    expect(findings.issues).toContain('progress.scenes_done 必须是字符串数组');
    expect(findings.scenesDone).toBeNull();
  });
});

describe('app/diagnostics/checks · 单项检查', () => {
  it('运行时版本：达标绿、低版本红（附升级命令）、不可解析红', async () => {
    const check = findCheck('runtime-node');
    const ok = await check.run(makeCtx({ nodeVersion: `v${REQUIRED_NODE_MAJOR}.0.0` }));
    expect(ok.status).toBe('pass');

    const low = await check.run(makeCtx({ nodeVersion: 'v18.19.0' }));
    expect(low.status).toBe('fail');
    expect(low.detail).toContain('低于要求');
    expect(low.fix).toContain('nvm install');

    const garbled = await check.run(makeCtx({ nodeVersion: '未知' }));
    expect(garbled.status).toBe('fail');
    expect(garbled.fix).toContain('nodejs.org');
  });

  it('项目锁：未实现——报「未实现」跳过且不崩溃（GAP-04 承接位）', async () => {
    const root = await makeTempRoot();
    const check = findCheck('project-lock');

    const absent = await check.run(makeCtx({ dir: root }));
    expect(absent.status).toBe('skip');
    expect(absent.detail).toContain('未实现');
    expect(absent.detail).toContain('W2-GAP-T04');

    await mkdir(path.join(root, '.sw'), { recursive: true });
    await writeFile(path.join(root, LOCK_FILE), 'pid: 1', 'utf8');
    const present = await check.run(makeCtx({ dir: root }));
    expect(present.status).toBe('skip');
    expect(present.detail).toContain('已发现 .sw/lock');
  });

  it('AI key：未启用绿；已启用报「未实现」跳过（网关属 TASK-P3-01）', async () => {
    const check = findCheck('ai-key');
    const off = await check.run(
      makeCtx({ findings: { issues: [], scenesDone: [], aiEnabled: false } }),
    );
    expect(off.status).toBe('pass');

    const on = await check.run(
      makeCtx({ findings: { issues: [], scenesDone: [], aiEnabled: true } }),
    );
    expect(on.status).toBe('skip');
    expect(on.detail).toContain('未实现');
    expect(on.detail).toContain('TASK-P3-01');
  });
});

describe('app/diagnostics/doctor · runDoctorWorkflow（验收①②③的工作流层）', () => {
  it('健康项目：零红项 ok=true，检查项顺序固定，锁为「未实现」跳过', async () => {
    const target = await makeHealthyProject();

    const report = await runDoctorWorkflow(target, doctorDeps);

    expect(report.ok).toBe(true);
    expect(report.failCount).toBe(0);
    expect(report.results.map((result) => result.id)).toEqual([
      'runtime-node',
      'project-file',
      'meta-schema',
      'layout',
      'scenes-done',
      'project-lock',
      'ai-key',
    ]);
    for (const result of report.results) {
      expect(['pass', 'skip']).toContain(result.status);
    }
    const lock = report.results.find((result) => result.id === 'project-lock');
    expect(lock?.status).toBe('skip');
    expect(lock?.detail).toContain('未实现');
    expect(report.passCount + report.skipCount).toBe(report.results.length);
  });

  it('损坏①删 project.yaml：项目文件红项附 sw init 修复命令，依赖项跳过', async () => {
    const target = await makeHealthyProject();
    await rm(path.join(target, 'project.yaml'));

    const report = await runDoctorWorkflow(target, doctorDeps);

    expect(report.ok).toBe(false);
    const projectFile = report.results.find((result) => result.id === 'project-file');
    expect(projectFile?.status).toBe('fail');
    expect(projectFile?.fix).toContain('sw init');
    for (const id of ['meta-schema', 'scenes-done', 'ai-key']) {
      expect(report.results.find((result) => result.id === id)?.status).toBe('skip');
    }
    // 布局与 project.yaml 无依赖，仍应为绿（脚手架其余部分完好）
    expect(report.results.find((result) => result.id === 'layout')?.status).toBe('pass');
  });

  it('损坏②改坏 schema：schema 红项指明期望/实际并附修复命令', async () => {
    const target = await makeHealthyProject();
    const yamlPath = path.join(target, 'project.yaml');
    const yaml = await readFile(yamlPath, 'utf8');
    await writeFile(yamlPath, yaml.replace('schema: 1', 'schema: 2'), 'utf8');

    const report = await runDoctorWorkflow(target, doctorDeps);

    expect(report.ok).toBe(false);
    const schema = report.results.find((result) => result.id === 'meta-schema');
    expect(schema?.status).toBe('fail');
    expect(schema?.detail).toContain('期望 1，实际 2');
    expect(schema?.fix).toContain('--force');
    expect(report.results.find((result) => result.id === 'project-file')?.status).toBe('pass');
  });

  it('损坏②变体·project.yaml 无法解析：schema 红项含解析原因，不抛异常', async () => {
    const target = await makeHealthyProject();
    await writeFile(path.join(target, 'project.yaml'), '{{{ 不是 yaml\n', 'utf8');

    const report = await runDoctorWorkflow(target, doctorDeps);

    expect(report.ok).toBe(false);
    const schema = report.results.find((result) => result.id === 'meta-schema');
    expect(schema?.status).toBe('fail');
    expect(schema?.detail).toContain('无法解析');
  });

  it('损坏③scenes_done 与磁盘不符：红项只列缺失编号并附 sw draft 修复指引（SPEC-05 §8.2 核销）', async () => {
    const target = await makeHealthyProject();
    const yamlPath = path.join(target, 'project.yaml');
    const yaml = await readFile(yamlPath, 'utf8');
    await writeFile(yamlPath, yaml.replace('scenes_done: []', 'scenes_done: ["001", "002"]'), 'utf8');
    await writeFile(path.join(target, 'scenes', '001-opening.md'), '# 开场\n', 'utf8');

    const report = await runDoctorWorkflow(target, doctorDeps);

    expect(report.ok).toBe(false);
    const scenes = report.results.find((result) => result.id === 'scenes-done');
    expect(scenes?.status).toBe('fail');
    expect(scenes?.detail).toContain('002');
    expect(scenes?.detail).not.toContain('001、');
    expect(scenes?.fix).toContain('sw draft 002');
  });

  it('scenes_done 全部有对应文件（含 <id>.md 变体）：绿', async () => {
    const target = await makeHealthyProject();
    const yamlPath = path.join(target, 'project.yaml');
    const yaml = await readFile(yamlPath, 'utf8');
    await writeFile(yamlPath, yaml.replace('scenes_done: []', 'scenes_done: ["001", "002"]'), 'utf8');
    await writeFile(path.join(target, 'scenes', '001-opening.md'), '# 开场\n', 'utf8');
    await writeFile(path.join(target, 'scenes', '002.md'), '# 第二场\n', 'utf8');

    const report = await runDoctorWorkflow(target, doctorDeps);

    expect(report.results.find((result) => result.id === 'scenes-done')?.status).toBe('pass');
    expect(report.ok).toBe(true);
  });

  it('布局损坏：缺 exports/ 与 outline.md 时红项列全缺失项，修复含 mkdir 与 sw outline', async () => {
    const target = await makeHealthyProject();
    await rm(path.join(target, 'exports'), { recursive: true });
    await rm(path.join(target, 'outline.md'));

    const report = await runDoctorWorkflow(target, doctorDeps);

    expect(report.ok).toBe(false);
    const layout = report.results.find((result) => result.id === 'layout');
    expect(layout?.status).toBe('fail');
    expect(layout?.detail).toContain('outline.md 缺失');
    expect(layout?.detail).toContain('exports/ 缺失');
    expect(layout?.fix).toContain('mkdir -p exports');
    expect(layout?.fix).toContain('sw outline');
  });

  it('对完全不存在的目录运行：产出完整报告（红项 + 跳过），不崩溃', async () => {
    const root = await makeTempRoot();

    const report = await runDoctorWorkflow(path.join(root, '不存在'), doctorDeps);

    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(DOCTOR_CHECKS.length);
    expect(report.results.find((result) => result.id === 'project-file')?.status).toBe('fail');
  });
});
