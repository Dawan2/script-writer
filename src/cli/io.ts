/**
 * 接口层·输出通道抽象（W3 集成槽，语义冲突 ⑦ 的统一落点）。
 *
 * 单一 IO 抽象：以 error 框架的注入口径（out/err）为正典——
 * src/cli/run.ts 顶层 catch 与各子命令 action 共用同一实例，
 * 测试注入即可捕获全部用户可见输出；init 向导的交互能力（提问/读行）
 * 并入时以扩展接口挂载于此模块，不得另起第二套 IO 形态。
 */

/** 输出通道抽象：默认写 stdout/stderr；测试注入以捕获输出。 */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

/** 进程默认通道（真实 stdout/stderr）。 */
export const processIo: CliIo = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};
