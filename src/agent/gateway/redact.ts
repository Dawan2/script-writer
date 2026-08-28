/**
 * 脱敏工具（TASK-P3-01，P3 方案 §2.7 规则 1：凭据永不落盘）。
 *
 * 唯一职责：把已知秘密值从任意要上抛/落盘的文本中抹除。
 * 纪律：网关与未来的 trace 层在**任何**字符串离开进程前必须过一遍本函数；
 * 秘密集合由调用方显式给出（网关给 apiKey），本函数不做模式猜测。
 */

/** 把 text 中所有 secrets 的出现替换为 ***；空串与过短值（<4 字符）不替换，防误伤。 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join('***');
  }
  return out;
}
