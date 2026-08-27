/**
 * 应用层·doctor 编排（W1-P1-T08）：预读 project.yaml → 依序执行注册表检查 → 汇总报告。
 *
 * 退出码语义（GAP-06：业务代码只产出报告不碰 process.exit）：
 * 报告 ok（零红项）→ 接口层退出码 0；任一红项 → 接口层 throw SwError → 退出码 1。
 * skip（未实现/前置未通过/不适用）不计红，不影响退出码。
 */

import path from 'node:path';
import { readProjectMetaFile } from '../../infra/store/projectMetaRead.js';
import { DOCTOR_CHECKS, type CheckOutcome, type CheckResult, type DoctorContext } from './checks.js';
import { validateRawProjectMeta } from './validate.js';

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

export async function runDoctorWorkflow(dirArg: string | undefined, deps: DoctorDeps): Promise<DoctorReport> {
  const dir = path.resolve(dirArg ?? '.');
  const projectFile = await readProjectMetaFile(dir);
  const findings = projectFile.state === 'parsed' ? validateRawProjectMeta(projectFile.raw) : null;
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
