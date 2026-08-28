/**
 * 应用层·`sw outline` 结果渲染（SPEC-02：命令输出末行为可直接复制执行的下一步命令）。
 * 失败态复用 statusReport.renderProjectFailure（三段式）；
 * TODO(W1-P1-T06)：错误框架合入后随 statusReport 一并迁移 fail()/hint() 统一渲染。
 */

import { OUTLINE_FILE, SCENES_DIR } from '../../infra/store/layout.js';
import type { OutlineOutcome } from './outline.js';
import { nextActionCommand } from './statusReport.js';

/** 成功态渲染：说明做了什么（创建 or 幂等保留）+ 引导 + 末行可复制的下一步命令。 */
export function renderOutlineReport(outcome: OutlineOutcome): string[] {
  const { action, status } = outcome;
  const opening =
    action === 'created'
      ? [
          `已创建 ${OUTLINE_FILE}（${status.meta.format} 模板骨架，标题与预计场数已代入）。`,
          `打开 ${OUTLINE_FILE} 按内嵌注释引导逐行填写：一行一场，行首编号与 ${SCENES_DIR}/ 下的文件名对应。`,
        ]
      : [`${OUTLINE_FILE} 已存在且有内容，未改动（幂等：只补缺、不覆盖）。`];
  return [...opening, '下一步（可直接复制执行）：', nextActionCommand(status)];
}
