/**
 * 接口层·输出通道抽象（W3 集成槽，语义冲突 ⑦ 的统一落点）。
 *
 * 单一 IO 抽象：以 error 框架的注入口径（out/err 函数）为正典——
 * src/cli/run.ts 顶层 catch 与各子命令 action 共用同一实例，
 * 测试注入即可捕获全部用户可见输出。
 *
 * init 向导的交互能力（读行提问）以可选成员 `stdin` 挂载：
 * 交互式命令经 `io.stdin ?? process.stdin` 读输入（测试注入 Readable 即可脚本化），
 * 非交互命令不触碰该成员。不得另起第二套 IO 形态（init 分支的流式 CliIo 已废弃）。
 */

/** 输出通道抽象：默认写 stdout/stderr；测试注入以捕获输出。 */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** 交互输入流（init 向导等读行用）；缺省时交互命令回退 process.stdin。 */
  stdin?: NodeJS.ReadableStream;
}

/** 进程默认通道（真实 stdin/stdout/stderr）。 */
export const processIo: CliIo = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
  stdin: process.stdin,
};
