/**
 * 接口层·可注入的标准流束（测试可注入 stdin/stdout/stderr，生产缺省取 process 流）。
 */

export interface CliIo {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export function processIo(): CliIo {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
}
