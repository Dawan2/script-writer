/**
 * 应用层·恢复式工作流引擎最小版（W1-P1-T05 / SPEC-02）。
 * 每个入口都遵循同一数据流：①读取并校验 project.yaml ②计算当前步骤与缺口
 * ③执行动作 ④原子回写状态 ⑤把结构化结果交给渲染层输出（statusReport.ts）。
 * 失败以判别联合返回而非裸异常，供渲染层输出三段式消息；
 * TODO(W1-P1-T06)：SPEC-03 错误框架合入后，失败分支迁移为 fail(code, ctx) 唯一入口。
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createProjectMeta,
  type CreateProjectMetaInput,
  type ProjectMeta,
} from '../../core/model/project.js';
import { parseProjectMeta } from '../../core/model/parseProject.js';
import {
  ensureStepAtLeast,
  recordSceneDone,
  sceneCompletion,
  type ProjectDiskSnapshot,
} from '../../core/model/progress.js';
import {
  readProjectFileRaw,
  scanProjectDisk,
  writeProjectFile,
} from '../../infra/store/projectFile.js';
import { CHARACTERS_DIR, EXPORTS_DIR, SCENES_DIR } from '../../infra/store/layout.js';

/** 引擎所有入口共用的失败分支（SPEC-03 错误码语义已标注，渲染层据此出三段式消息）。 */
export type ProjectFailure =
  /** SW-E011 语义：目录下无 project.yaml，不是 script-writer 项目。 */
  | { ok: false; reason: 'not-a-project' }
  /** project.yaml 存在但不是合法 YAML。 */
  | { ok: false; reason: 'invalid-yaml'; detail: string }
  /** SW-E020 语义：schema 版本不兼容，需迁移。 */
  | { ok: false; reason: 'schema-incompatible'; found: unknown; expected: number }
  /** 字段缺失或类型错误（issues 逐条）。 */
  | { ok: false; reason: 'malformed'; issues: string[] };

export type LoadProjectResult = { ok: true; meta: ProjectMeta } | ProjectFailure;

/** 引擎数据流 ①：读取并校验 project.yaml（任何命令的第一步）。 */
export async function loadProject(projectDir: string): Promise<LoadProjectResult> {
  const raw = await readProjectFileRaw(projectDir);
  if (!raw.exists) {
    return { ok: false, reason: 'not-a-project' };
  }
  if (!raw.ok) {
    return { ok: false, reason: 'invalid-yaml', detail: raw.detail };
  }
  const parsed = parseProjectMeta(raw.data);
  if (!parsed.ok) {
    return parsed.reason === 'schema-incompatible'
      ? { ok: false, reason: 'schema-incompatible', found: parsed.found, expected: parsed.expected }
      : { ok: false, reason: 'malformed', issues: parsed.issues };
  }
  return { ok: true, meta: parsed.meta };
}

/** 引擎数据流 ④：原子回写状态（临时文件 + rename，中断安全）。 */
export async function saveProject(projectDir: string, meta: ProjectMeta): Promise<void> {
  await writeProjectFile(projectDir, meta);
}

export type InitProjectResult =
  | { ok: true; meta: ProjectMeta }
  /** 目录已是项目：幂等约束下报错且不改动现场（SPEC-01"重复 init 报错不破坏现场"）。 */
  | { ok: false; reason: 'already-a-project' };

/**
 * 初始化挂钩：schema v1 工厂产出默认元数据 → 建标准子目录 → 原子写 project.yaml。
 * 供 SPEC-01 init 向导（W1-P1-T04，并行槽）在收集完答案后调用；
 * 模板渲染（outline.md 骨架等）属向导职责，本挂钩只负责状态源与目录骨架。
 */
export async function initProject(
  projectDir: string,
  input: CreateProjectMetaInput,
): Promise<InitProjectResult> {
  const existing = await readProjectFileRaw(projectDir);
  if (existing.exists) {
    return { ok: false, reason: 'already-a-project' };
  }
  const meta = createProjectMeta(input);
  await mkdir(projectDir, { recursive: true });
  for (const dir of [SCENES_DIR, CHARACTERS_DIR, EXPORTS_DIR]) {
    await mkdir(join(projectDir, dir), { recursive: true });
  }
  await writeProjectFile(projectDir, meta);
  return { ok: true, meta };
}

export type MarkSceneDoneResult = { ok: true; meta: ProjectMeta } | ProjectFailure;

/**
 * 记录场景完成（draft 步的状态回写原语，供 sw draft 落地时复用）：
 * 读 → 幂等记录 + 步骤补齐（可跳过语义：outline 未走完也允许直接 draft）→ 原子写回。
 */
export async function markSceneDone(
  projectDir: string,
  sceneId: string,
): Promise<MarkSceneDoneResult> {
  const loaded = await loadProject(projectDir);
  if (!loaded.ok) {
    return loaded;
  }
  const progress = ensureStepAtLeast(recordSceneDone(loaded.meta.progress, sceneId), 'draft');
  if (progress === loaded.meta.progress) {
    return loaded; // 幂等：无变化则不写盘
  }
  const meta: ProjectMeta = { ...loaded.meta, progress };
  await saveProject(projectDir, meta);
  return { ok: true, meta };
}

/** sw status 的结构化输出（渲染层据此产出文本，末行为可复制的下一步命令）。 */
export interface ProjectStatus {
  meta: ProjectMeta;
  disk: ProjectDiskSnapshot;
  scenes: { done: number; total: number };
}

export type ReadStatusResult = { ok: true; status: ProjectStatus } | ProjectFailure;

/** 恢复入口：任意时刻中断后，读状态源 + 扫磁盘即可找回"我在第几步"（SPEC-02 目标）。 */
export async function readStatus(projectDir: string): Promise<ReadStatusResult> {
  const loaded = await loadProject(projectDir);
  if (!loaded.ok) {
    return loaded;
  }
  const disk = await scanProjectDisk(projectDir);
  return {
    ok: true,
    status: {
      meta: loaded.meta,
      disk,
      scenes: sceneCompletion(loaded.meta.progress, disk, loaded.meta.expectedSceneCount),
    },
  };
}
