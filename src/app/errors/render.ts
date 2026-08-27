/**
 * 应用层·统一渲染层（W1-P1-T06 / SPEC-03）。
 *
 * 所有面向用户的错误与空态输出必须经由本层（P1 §5.2 UX 强制通道）：
 * - renderError()：三段式错误消息（发生了什么 / 原因 / 怎么办）+ 文档锚点；
 * - renderHint()：空态三要素（这里是什么 / 示例 / 下一步命令）；
 * - renderUnexpectedError()：未经 fail() 的裸异常兜底（仍按退出码 1 处理，见 SPEC-03-EXT）。
 *
 * 本层只产字符串、零 IO；打印与退出码由接口层（src/cli/run.ts）统一负责。
 */

import type { ErrorCode, HintContexts, HintSlot, SwError, TemplateValue } from './registry.js';
import { ERROR_REGISTRY, HINT_REGISTRY, errorDocsUrl } from './registry.js';

/** 数组以「、」连接；空数组渲染为「（无）」——E030 附现有 id 列表等场景共用。 */
export function formatTemplateValue(value: TemplateValue): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? '（无）' : value.join('、');
  }
  return String(value);
}

/** 把模板中的 `{key}` 占位符替换为 ctx 对应值；未知占位符原样保留（由注册表 lint 拦截）。 */
export function formatTemplate(template: string, ctx: Record<string, TemplateValue>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, key: string) => {
    const value = ctx[key];
    return value === undefined ? match : formatTemplateValue(value);
  });
}

/**
 * 三段式错误消息（SPEC-03 消息模板，渲染层强制）：
 *
 *   ✖ SW-E011 当前目录不是 script-writer 项目
 *     原因：未找到 project.yaml（查找位置：/home/writer/somewhere）。
 *     怎么办：运行 `sw init` 新建项目，或 cd 到既有项目目录。
 *     详情：https://…/docs/errors/SW-E011.md
 */
export function renderError<C extends ErrorCode>(error: SwError<C>): string {
  const spec = ERROR_REGISTRY[error.code];
  const ctx = error.ctx as Record<string, TemplateValue>;
  return [
    `✖ ${error.code} ${formatTemplate(spec.what, ctx)}`,
    `  原因：${formatTemplate(spec.why, ctx)}`,
    `  怎么办：${formatTemplate(spec.fix, ctx)}`,
    `  详情：${errorDocsUrl(error.code)}`,
  ].join('\n');
}

/**
 * 空态三要素（P1 §6.3）：
 *
 *   ○ scenes/ 目前是空的——这里按「一场一文件」存放每一场的正文（Markdown）。
 *     示例：scenes/010-opening.md（三位场编号-英文短名.md）
 *     下一步：sw draft 010 --title "开场"
 *
 * 「下一步」行冒号后为完整可复制命令（禁止行尾附注）。
 */
export function renderHint<S extends HintSlot>(slot: S, ctx: HintContexts[S]): string {
  const spec = HINT_REGISTRY[slot];
  const values = ctx as Record<string, TemplateValue>;
  return [
    `○ ${formatTemplate(spec.what, values)}`,
    `  示例：${formatTemplate(spec.example, values)}`,
    `  下一步：${formatTemplate(spec.next, values)}`,
  ].join('\n');
}

/**
 * 裸异常兜底：未经 fail() 的异常属实现缺陷（违反 SPEC-03 唯一入口约定），
 * 渲染为可上报的形态；退出码仍为 1（SPEC-03-EXT「运行期错误」）。
 */
export function renderUnexpectedError(error: unknown): string {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return [
    '✖ 发生未预期的内部错误（该错误未经统一错误框架，属实现缺陷）',
    '  怎么办：请携带以下详情到 https://github.com/Dawan2/script-writer/issues 反馈。',
    `  详情：${detail}`,
  ].join('\n');
}
