type Teardown = () => void;

const teardowns: Teardown[] = [];

/** 由各注入工具登记，测试结束后自动还原全局状态。 */
export function registerTeardown(teardown: Teardown): void {
  teardowns.push(teardown);
}

/** 还原本次测试安装的全部注入，按安装的逆序执行。 */
export function resetHarness(): void {
  const failures: unknown[] = [];
  while (teardowns.length) {
    const teardown = teardowns.pop();
    try {
      teardown?.();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
}
