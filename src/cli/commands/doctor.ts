/**
 * 接口层·`sw doctor` 子命令（W1-P1-T08，方案 §6.7；移植自 `cursor/w3-doctor-3e3d` 适配 fail() 框架）。
 *
 * 职责：报告渲染（绿 ✔ / 红 ✖ / 跳过 ○，红项附「修复」行）与退出码接线：
 * 全绿（红项 = 0）正常返回 → 退出码 0；存在红项 fail('SW-E014') 由顶层
 * 统一裁定为退出码 1（GAP-06）。检查逻辑在 src/app/diagnostics/。
 *
 * 错误码注记（撞号裁定）：源分支以 SW-E013 聚合红项，但 E013 在集成分支
 * 已被 init「目标路径是文件」先行占用（先落地为准）；012 号为 GAP-04 锁占用预留——
 * 故红项聚合顺延取 SW-E014，与首个触达用例同提交登记（docs/wave-03/work-doctor.md 勘误）。
 */

import { Command } from 'commander';
import { runDoctorWorkflow, type DoctorReport } from '../../app/diagnostics/doctor.js';
import type { CheckStatus } from '../../app/diagnostics/checks.js';
import { fail } from '../../app/errors/registry.js';
import type { CliIo } from '../io.js';

const DOCTOR_EXAMPLES = `
示例：
  $ sw doctor               # 自检当前目录的项目
  $ sw doctor my-story      # 自检指定项目目录

检查项：运行时版本 / 项目文件 / 元数据 schema / 目录布局 / 场景一致性 / 项目锁 / AI key。
退出码：全部检查项通过（无红项）为 0；存在红项为 1（每个红项均附可复制的「修复」命令）。
`;

const STATUS_SYMBOL: Record<CheckStatus, string> = {
  pass: '✔',
  fail: '✖',
  skip: '○',
};

export function renderDoctorReport(report: DoctorReport): string {
  const lines = [`sw doctor · 项目自检：${report.dir}`, ''];
  for (const result of report.results) {
    lines.push(`${STATUS_SYMBOL[result.status]} ${result.title}：${result.detail}`);
    if (result.status === 'fail' && result.fix !== undefined) {
      lines.push(`  修复：${result.fix}`);
    }
  }
  lines.push('');
  const tally = `${report.passCount} 绿 / ${report.failCount} 红 / ${report.skipCount} 跳过（未实现或不适用，不计红）`;
  lines.push(
    report.ok
      ? `结论：${tally} —— 未发现需要处理的问题`
      : `结论：${tally} —— 按上方红项的「修复」命令处理后重跑 \`sw doctor\``,
  );
  return lines.join('\n');
}

/** 注册 doctor 子命令（经命令注册表挂载循环调用；aux 组，无别名）。 */
export function registerDoctorCommand(program: Command, io: CliIo): void {
  program
    .command('doctor')
    .description('环境与项目自检：逐项绿/红 + 修复命令（全绿退出码 0，否则 1）')
    .argument('[dir]', '项目目录（缺省：当前目录）')
    .addHelpText('after', DOCTOR_EXAMPLES)
    .action(async (dir: string | undefined) => {
      const report = await runDoctorWorkflow(dir, { nodeVersion: () => process.version });
      io.out(`${renderDoctorReport(report)}\n`);
      if (!report.ok) {
        const redTitles = report.results
          .filter((result) => result.status === 'fail')
          .map((result) => result.title);
        fail('SW-E014', { count: report.failCount, findings: redTitles });
      }
    });
}
