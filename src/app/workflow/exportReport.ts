/**
 * 应用层·`sw export` 结果渲染（SPEC-06 §5.3）。
 * 报告 = 产物路径 + 场数与完成度 + 未覆盖提示行（scenes_done 未覆盖全部磁盘场时，
 * 引导 `sw draft <id> --done`，不阻塞导出）；末行 = 可复制的收尾命令 `sw status`（导出是链尾）。
 */

import type { ExportOutcome } from './export.js';

/** 成功态渲染。 */
export function renderExportReport(outcome: ExportOutcome): string[] {
  const lines = [
    `已导出：${outcome.outPath}（markdown v1${outcome.outlineIncluded ? '' : '，大纲节省略'}）。`,
    `导出 ${outcome.sceneCount} 场（已标记完成 ${outcome.doneCount}/${outcome.sceneCount}）。`,
  ];
  if (outcome.unfinishedIds.length > 0) {
    lines.push(
      `提示：场 ${outcome.unfinishedIds.join('、')} 尚未标记完成（不影响导出）；写完后执行 \`sw draft ${outcome.unfinishedIds[0]} --done\`。`,
    );
  }
  return [...lines, '下一步（可直接复制执行）：', 'sw status'];
}
