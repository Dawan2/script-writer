/**
 * 应用层·`sw revise` 结果渲染（SPEC-04：末行 = 可直接复制执行的下一步命令）。
 * 空态走 ES-07 空态三要素（hint 注册表单一数据源）；清单纯文本稳定可供脚本消费；
 * 未实现的 P4 工具（sw check/sw stats）不引荐（SPEC-04 验收 ④：渐进增强，无硬依赖）。
 */

import { renderHint } from '../errors/render.js';
import { SCENES_DIR } from '../../infra/store/layout.js';
import type { ReviseOutcome } from './revise.js';

function renderEntries(outcome: ReviseOutcome): string[] {
  const lines = ['修订清单（id ｜ 状态 ｜ 标题）：'];
  for (const entry of outcome.entries) {
    lines.push(`  ${entry.id} ｜ ${entry.revised ? '已修订' : '未修订'} ｜ ${entry.title}`);
  }
  return lines;
}

/** 成功态渲染。 */
export function renderReviseReport(outcome: ReviseOutcome): string[] {
  if (outcome.action === 'empty') {
    return [renderHint('revise-empty', {})];
  }
  if (outcome.action === 'opened') {
    const path = `${SCENES_DIR}/${outcome.fileName}`;
    return [
      `已打开场 ${outcome.sceneId}：${path}（在编辑器中修订正文）。`,
      '修订完成后执行末行命令标记本场已修订。',
      '下一步（可直接复制执行）：',
      outcome.nextCommand, // sw revise <id> --done
    ];
  }
  if (outcome.action === 'done') {
    return [
      `已标记修订：场 ${outcome.sceneId}（${SCENES_DIR}/${outcome.fileName}）。`,
      '下一步（可直接复制执行）：',
      outcome.nextCommand,
    ];
  }
  // listed：清单 + 建议
  return [...renderEntries(outcome), '下一步（可直接复制执行）：', outcome.nextCommand];
}
