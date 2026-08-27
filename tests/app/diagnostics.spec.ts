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
import { validateRawProjectMeta } from '../../src/app/diagnostics/validate.js';
import { runInitWorkflow, type InitDeps } from '../../src/app/workflow/init.js';
import { createProjectMeta } from '../../src/core/model/project.js';
import { serializeProjectMeta } from '../../src/infra/store/projectFile.js';
import { parseProjectMetaText, type RawMap } from '../../src/infra/store/projectMetaRead.js';

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sw-doctor-app-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const silentDeps: InitDeps = {
  ask: () => Promise.resolve(''),
  info: () => undefined,
  today: () => '2026-08-27',
};

/** 健康项目夹具：真实走 init 工作流产出（与 SPEC-01 布局一致）。 */
async function makeHealthyProject(): Promise<string> {
  const root = await makeTempRoot();
  const target = path.join(root, 'proj');
  await runInitWorkflow(target, { yes: true }, silentDeps);
  return target;
}

function healthyRaw(): RawMap {
  const meta = createProjectMeta({ title: 't', created: '2026-08-27', expectedSceneCount: 5 });
  const outcome = parseProjectMetaText(serializeProjectMeta(meta));
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.raw;
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

describe('app/diagnostics/validate · 字段级校验（逐条问题清单）', () => {
  it('健康 project.yaml：零问题，并给出下游视图（scenesDone/aiEnabled）', () => {
    const findings = validateRawProjectMeta(healthyRaw());
    expect(findings.issues).toEqual([]);
    expect(findings.scenesDone).toEqual([]);
    expect(findings.aiEnabled).toBe(false);
  });

  it('schema 版本不符（验收②「改坏 schema」内核）：问题指明期望与实际', () => {
    const raw = healthyRaw();
    raw.schema = 2;
    const findings = validateRawProjectMeta(raw);
    expect(findings.issues).toEqual(['schema 版本不符（期望 1，实际 2）']);
  });

  it('schema 缺失或非数字', () => {
    const raw = healthyRaw();
    delete raw.schema;
    expect(validateRawProjectMeta(raw).issues).toContain('缺少 schema 字段或其值不是数字');
    raw.schema = 'one';
    expect(validateRawProjectMeta(raw).issues).toContain('缺少 schema 字段或其值不是数字');
  });

  it('title / format / created / expectedSceneCount 逐项校验', () => {
    const raw = healthyRaw();
    raw.title = '';
    raw.format = 'novel';
    raw.created = '2026/08/27';
    raw.expectedSceneCount = 0;
    const { issues } = validateRawProjectMeta(raw);
    expect(issues).toContain('缺少 title 或其值不是非空字符串');
    expect(issues.some((issue) => issue.startsWith('format 非法'))).toBe(true);
    expect(issues).toContain('created 不是 YYYY-MM-DD 日期');
    expect(issues).toContain('expectedSceneCount 必须是正整数（GAP-03）');
  });

  it('expectedSceneCount 可选：字段缺失不报问题（GAP-03 旧式文件可读）', () => {
    const raw = healthyRaw();
    delete raw.expectedSceneCount;
    expect(validateRawProjectMeta(raw).issues).toEqual([]);
  });

  it('settings.ai / settings.export 结构非法时各出一条，且 aiEnabled 视图为 null', () => {
    const raw = healthyRaw();
    raw.settings = { ai: { enabled: 'yes', provider: null }, export: { default: '' } };
    const findings = validateRawProjectMeta(raw);
    expect(findings.issues).toContain('settings.ai 结构非法（需 enabled 布尔与 provider 字符串或 null）');
    expect(findings.issues).toContain('settings.export 结构非法（需 default 非空字符串）');
    expect(findings.aiEnabled).toBeNull();
  });

  it('progress.step 非法与 scenes_done 非字符串数组时各出一条，scenesDone 视图为 null', () => {
    const raw = healthyRaw();
    raw.progress = { step: 'flying', scenes_done: 'nope' };
    const findings = validateRawProjectMeta(raw);
    expect(findings.issues.some((issue) => issue.startsWith('progress.step 非法'))).toBe(true);
    expect(findings.issues).toContain('progress.scenes_done 必须是字符串数组');
    expect(findings.scenesDone).toBeNull();
  });

  it('settings / progress 小节整体缺失', () => {
    const raw = healthyRaw();
    delete raw.settings;
    delete raw.progress;
    const { issues } = validateRawProjectMeta(raw);
    expect(issues).toContain('缺少 settings 小节');
    expect(issues).toContain('缺少 progress 小节');
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

  it('损坏③scenes_done 与磁盘不符：红项只列缺失编号并附修复指引', async () => {
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
    expect(scenes?.fix).toContain('scenes_done');
    expect(scenes?.fix).toContain('W1-P1-T05');
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

  it('布局损坏：缺 exports/ 与 outline.md 时红项列全缺失项，修复含 mkdir 与 --force 重建', async () => {
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
    expect(layout?.fix).toContain('--force');
  });

  it('对完全不存在的目录运行：产出完整报告（红项 + 跳过），不崩溃', async () => {
    const root = await makeTempRoot();

    const report = await runDoctorWorkflow(path.join(root, '不存在'), doctorDeps);

    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(DOCTOR_CHECKS.length);
    expect(report.results.find((result) => result.id === 'project-file')?.status).toBe('fail');
  });
});
