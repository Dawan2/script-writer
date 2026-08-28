/**
 * 应用层·`sw draft` 结果渲染（SPEC-05 §4.4：末行 = 可直接复制执行的下一步命令）。
 * 创建/保留路径末行 = 本场的完成命令 `sw draft <id> --done`；
 * --done 路径末行 = nextActionCommand(status)（指向下一场 / export）。
 */

import { SCENES_DIR } from '../../infra/store/layout.js';
import type { DraftOutcome } from './draft.js';
import { nextActionCommand } from './statusReport.js';

/** 成功态渲染：说明做了什么 + 引导 + 末行可复制的下一步命令。 */
export function renderDraftReport(outcome: DraftOutcome): string[] {
  const { action, sceneId, fileName, outlineFilled, titleIgnored, status } = outcome;
  const path = `${SCENES_DIR}/${fileName}`;
  const opening: string[] = [];
  if (outlineFilled) {
    opening.push('已顺手补齐大纲骨架（outline.md 缺失/为空，按模板生成）。');
  }
  if (action === 'created') {
    opening.push(
      `已创建 ${path}（场骨架含内嵌引导注释）。`,
      `打开 ${path} 写本场正文；写完后执行末行命令标记完成。`,
    );
  } else if (action === 'kept') {
    opening.push(
      `${path} 已存在，未改动（幂等：只补缺、不覆盖）。` +
        (titleIgnored ? '本次 --title 未消费（场已存在不改名）。' : ''),
      `打开 ${path} 续写本场正文；写完后执行末行命令标记完成。`,
    );
  } else {
    opening.push(`已标记完成：场 ${sceneId}（${path}）。`);
  }
  const last =
    action === 'done' ? nextActionCommand(status) : `sw draft ${sceneId} --done`;
  return [...opening, '下一步（可直接复制执行）：', last];
}
