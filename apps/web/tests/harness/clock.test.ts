import { describe, expect, it } from "vitest";

import { installClock } from "../support/clock";

describe("可控时钟", () => {
  it("从指定时间起算，推进后时间随之变化", async () => {
    const clock = installClock({ now: "2026-03-05T10:00:00Z" });

    expect(clock.date().toISOString()).toBe("2026-03-05T10:00:00.000Z");
    await clock.advance(90_000);
    expect(clock.date().toISOString()).toBe("2026-03-05T10:01:30.000Z");
  });

  it("退避间隔的断言不依赖真实等待", async () => {
    const realStart = Date.now();
    const clock = installClock();
    const firedAt: number[] = [];
    const start = clock.now();
    for (const delay of [1_000, 2_000, 4_000]) {
      setTimeout(() => firedAt.push(clock.now() - start), delay);
    }

    await clock.advance(7_000);
    clock.uninstall();

    expect(firedAt).toEqual([1_000, 2_000, 4_000]);
    expect(Date.now() - realStart).toBeLessThan(7_000);
  });

  it("推进到下一个定时器，无需知道具体间隔", async () => {
    const clock = installClock();
    let value = "";
    setTimeout(() => {
      value = "第一次重试";
    }, 30_000);

    expect(clock.pendingTimers()).toBe(1);
    await clock.advanceToNextTimer();
    expect(value).toBe("第一次重试");
    expect(clock.pendingTimers()).toBe(0);
  });

  it("周期任务按推进的时长触发相应次数", async () => {
    const clock = installClock();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5_000);

    await clock.advance(12_000);
    clearInterval(timer);

    expect(ticks).toBe(2);
  });

  it("还原后回到真实时钟", async () => {
    const clock = installClock({ now: "2020-01-01T00:00:00Z" });
    expect(clock.now()).toBe(Date.parse("2020-01-01T00:00:00Z"));

    clock.uninstall();
    expect(Date.now()).toBeGreaterThan(Date.parse("2024-01-01T00:00:00Z"));
  });
});
