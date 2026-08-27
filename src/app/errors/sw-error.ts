/**
 * 应用层·SW-Exxx 错误最小载体（W1-P1-T04 暂行版）。
 *
 * TODO(W1-P1-T06)：迁移到 SPEC-03 错误码注册表 + `fail(code, ctx)` 唯一抛错入口 +
 * 统一渲染层；届时本文件并入 `src/app/errors/registry.ts` / `render.ts`，
 * 并在消息尾部追加 `docs/errors/SW-Exxx` 文档锚点（生成器就位前不印死链）。
 *
 * 退出码约定（W2 GAP-06 / SPEC-03-EXT）：本错误经接口层顶层 catch 渲染后退出码恒为 1；
 * 业务代码只 throw 不碰 process.exit。
 */

export interface SwErrorSpec {
  /** 错误码（SW-Exxx，段位见 SPEC-03 注册表草案） */
  code: string;
  /** 发生了什么（一行） */
  what: string;
  /** 为什么 */
  why: string;
  /** 怎么办（含可复制命令） */
  how: string;
}

export class SwError extends Error {
  readonly code: string;
  readonly what: string;
  readonly why: string;
  readonly how: string;

  constructor(spec: SwErrorSpec) {
    super(`${spec.code} ${spec.what}`);
    this.name = 'SwError';
    this.code = spec.code;
    this.what = spec.what;
    this.why = spec.why;
    this.how = spec.how;
  }
}

/** SPEC-03 三段式消息模板（发生了什么 / 为什么 / 怎么办）。 */
export function renderSwError(error: SwError): string {
  return [
    `✖ ${error.code} ${error.what}`,
    `  原因：${error.why}`,
    `  怎么办：${error.how}`,
  ].join('\n');
}
