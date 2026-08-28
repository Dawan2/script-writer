/**
 * 应用层·doctor 编排（W1-P1-T08）：预读 project.yaml 一次（多检查共享）→ 依序执行注册表 → 汇总报告。
 *
 * 退出码语义（GAP-06：业务代码只产出报告不碰 process.exit）：
 * 报告 ok（零红项）→ 接口层退出码 0；任一红项 → 接口层 fail('SW-E014') → 退出码 1。
 * skip（未实现/前置未通过/不适用）不计红，不影响退出码。
 * 单项检查抛异常（如权限/磁盘故障）转红项，报告仍完整产出——诊断命令本身不崩溃。
 */

import path from 'node:path';
import { PROJECT_FILE } from '../../infra/store/layout.js';
import { inspectDir, readProjectFileRaw } from '../../infra/store/projectFile.js';
import {
  DOCTOR_CHECKS,
  type CheckOutcome,
  type CheckResult,
  type DoctorContext,
  type DoctorProjectFile,
} from './checks.js';
import { validateProjectMeta, type ProjectMetaFindings } from './validate.js';

export interface DoctorDeps {
  /** Node 版本串（生产取 process.version；注入以便测试） */
  nodeVersion(): string;
}

export interface DoctorReport {
  /** 项目根（绝对路径） */
  dir: string;
  results: CheckResult[];
  passCount: number;
  failCount: number;
  skipCount: number;
  /** 零红项（诊断命令本身总能跑完，红项经退出码而非异常表达） */
  ok: boolean;
}

/** project.yaml 预读四态：not-file 由 inspectDir 判定；非法 YAML 由引擎读侧给出解析细节。 */
async function readDoctorProjectFile(dir: string): Promise<{
  projectFile: DoctorProjectFile;
  findings: ProjectMetaFindings | null;
}> {
  const state = await inspectDir(path.join(dir, PROJECT_FILE));
  if (state === 'missing') {
    return { projectFile: { state: 'missing' }, findings: null };
  }
  if (state !== 'file') {
    return { projectFile: { state: 'not-file' }, findings: null };
  }
  const raw = await readProjectFileRaw(dir);
  if (!raw.exists) {
    return { projectFile: { state: 'missing' }, findings: null };
  }
  if (!raw.ok) {
    return { projectFile: { state: 'invalid', reason: raw.detail }, findings: null };
  }
  return { projectFile: { state: 'parsed' }, findings: validateProjectMeta(raw.data) };
}

export async function runDoctorWorkflow(
  dirArg: string | undefined,
  deps: DoctorDeps,
): Promise<DoctorReport> {
  const dir = path.resolve(dirArg ?? '.');
  const { projectFile, findings } = await readDoctorProjectFile(dir);
  const ctx: DoctorContext = { dir, dirArg, nodeVersion: deps.nodeVersion(), projectFile, findings };

  const results: CheckResult[] = [];
  for (const check of DOCTOR_CHECKS) {
    let outcome: CheckOutcome;
    try {
      outcome = await check.run(ctx);
    } catch (error) {
      // 诊断命令的鲁棒性要求：单项异常（如权限/磁盘故障）转红项，报告仍须完整产出。
      const message = error instanceof Error ? error.message : String(error);
      outcome = {
        status: 'fail',
        detail: `检查执行异常：${message}`,
        fix: '排除异常原因（如文件权限、磁盘状态）后重跑 `sw doctor`',
      };
    }
    results.push({ id: check.id, title: check.title, ...outcome });
  }

  const passCount = results.filter((result) => result.status === 'pass').length;
  const failCount = results.filter((result) => result.status === 'fail').length;
  const skipCount = results.filter((result) => result.status === 'skip').length;
  return { dir, results, passCount, failCount, skipCount, ok: failCount === 0 };
}
