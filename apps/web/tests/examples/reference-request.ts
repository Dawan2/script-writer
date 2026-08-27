/**
 * 示例用的最小请求实现，只为演示测试基座怎么写超时、退避、重试的断言。
 * 生产代码的请求核心由 C1-W1-03 落地，本文件不被 src 引用，也不应被产品代码导入。
 */
export interface RetryOptions {
  timeoutMs: number;
  /** 首次失败后的等待时长，之后逐次翻倍。 */
  backoffMs: number;
  /** 最多重试次数，不含首次请求。 */
  maxRetries: number;
}

export interface AttemptLog {
  attempt: number;
  outcome: "ok" | "timeout" | "serverError" | "networkError";
  startedAt: number;
}

export async function requestWithRetry(
  url: string,
  options: RetryOptions
): Promise<{ response: Response; attempts: AttemptLog[] }> {
  const attempts: AttemptLog[] = [];

  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status >= 500) {
        attempts.push({ attempt, outcome: "serverError", startedAt });
      } else {
        attempts.push({ attempt, outcome: "ok", startedAt });
        return { response, attempts };
      }
    } catch (error) {
      const aborted = (error as Error).name === "AbortError";
      attempts.push({ attempt, outcome: aborted ? "timeout" : "networkError", startedAt });
    } finally {
      clearTimeout(timer);
    }

    if (attempt > options.maxRetries) break;
    await sleep(options.backoffMs * 2 ** (attempt - 1));
  }

  throw new Error(`请求失败，已重试 ${attempts.length - 1} 次：${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
