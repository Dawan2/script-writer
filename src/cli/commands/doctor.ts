/**
 * 接口层·`sw doctor` 子命令（W1-P1-T08，方案 §6.7）。
 *
 * 职责：报告渲染（绿 ✔ / 红 ✖ / 跳过 ○，红项附「修复」行）与退出码接线：
 * 全绿（红项 = 0）正常返回 → 退出码 0；存在红项 throw `SW-E013` 由顶层
 * 统一裁定为退出码 1（GAP-06）。检查逻辑在 src/app/diagnostics/。
 *
 * 错误码注记：E01x 段中 SW-E012 已被 GAP-04 预留给「并发锁占用」（W2-GAP-T04），
 * 故自检未通过顺延取 SW-E013，请 W1-P1-T06 建注册表时一并收录。
 */

import { Command } from 'commander';
import { runDoctorWorkflow, type DoctorReport } from '../../app/diagnostics/doctor.js';
import type { CheckStatus } from '../../app/diagnostics/checks.js';
import { SwError } from '../../app/errors/sw-error.js';
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

export function registerDoctorCommand(program: Command, io: CliIo): void {
  program
    .command('doctor')
    .description('环境与项目自检：逐项绿/红 + 修复命令（全绿退出码 0，否则 1）')
    .argument('[dir]', '项目目录（缺省：当前目录）')
    .addHelpText('after', DOCTOR_EXAMPLES)
    .action(async (dir: string | undefined) => {
      const report = await runDoctorWorkflow(dir, { nodeVersion: () => process.version });
      io.stdout.write(`${renderDoctorReport(report)}\n`);
      if (!report.ok) {
        const redTitles = report.results
          .filter((result) => result.status === 'fail')
          .map((result) => result.title)
          .join('、');
        throw new SwError({
          code: 'SW-E013',
          what: `项目自检未通过（${report.failCount} 个红项）`,
          why: `红项：${redTitles}。`,
          how: `按上方报告各红项的「修复」命令逐项处理后重跑 \`sw doctor${dir === undefined ? '' : ` ${dir}`}\`。`,
        });
      }
    });
}
