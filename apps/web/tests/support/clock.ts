import { vi } from "vitest";

import { registerTeardown } from "./lifecycle";

export interface TestClock {
  /** 当前时间戳（毫秒）。 */
  now(): number;
  /** 当前时间。 */
  date(): Date;
  /** 推进指定毫秒数，到期的定时器与它们引发的 Promise 都会结算完毕。 */
  advance(ms: number): Promise<void>;
  /** 推进到下一个到期的定时器，用于断言退避间隔而不必知道具体数值。 */
  advanceToNextTimer(): Promise<void>;
  /** 执行所有已排队的一次性定时器；存在周期定时器时请改用 advance。 */
  runPending(): Promise<void>;
  /** 不推进时间，只把已排队的微任务结算完毕。 */
  flush(): Promise<void>;
  /** 尚未触发的定时器数量。 */
  pendingTimers(): number;
  /** 提前还原真实时钟；通常不必调用，测试结束会自动还原。 */
  uninstall(): void;
}

export interface ClockOptions {
  /** 起始时间，可传 ISO 字符串、Date 或时间戳。默认 2026-01-01T00:00:00Z。 */
  now?: string | number | Date;
}

const FAKED = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
  "performance",
  "requestAnimationFrame",
  "cancelAnimationFrame"
] as const;

/**
 * 安装可控时钟：接管定时器与时间读取，让超时、退避、轮询间隔的断言不依赖真实等待。
 *
 * 故障注入的响应延迟也走全局定时器，因此装上可控时钟后延迟同样由 advance 驱动。
 */
export function installClock(options: ClockOptions = {}): TestClock {
  const start = options.now ?? "2026-01-01T00:00:00Z";
  vi.useFakeTimers({ now: new Date(start), toFake: [...FAKED] });

  let installed = true;
  const uninstall = () => {
    if (!installed) return;
    installed = false;
    vi.useRealTimers();
  };
  registerTeardown(uninstall);

  const assertInstalled = () => {
    if (!installed) throw new Error("可控时钟已还原，请重新调用 installClock()");
  };

  const flush = async () => {
    for (let i = 0; i < 3; i += 1) await Promise.resolve();
  };

  return {
    now: () => Date.now(),
    date: () => new Date(Date.now()),
    async advance(ms) {
      assertInstalled();
      await vi.advanceTimersByTimeAsync(ms);
      await flush();
    },
    async advanceToNextTimer() {
      assertInstalled();
      await vi.advanceTimersToNextTimerAsync();
      await flush();
    },
    async runPending() {
      assertInstalled();
      await vi.runAllTimersAsync();
      await flush();
    },
    flush,
    pendingTimers: () => vi.getTimerCount(),
    uninstall
  };
}
