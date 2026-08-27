import { registerTeardown } from "./lifecycle";

export interface StorageSandbox {
  /** 预置初始内容。 */
  seed(entries: Record<string, string>): void;
  /** 读回当前全部内容，用于断言写入结果。 */
  snapshot(): Record<string, string>;
  /** 让后续写入抛错，模拟隐私模式或配额耗尽。传 null 取消。 */
  failWrites(errorName: string | null): void;
  /** 该沙箱上发生过的写入次数。 */
  writeCount(): number;
}

export interface StorageSandboxes {
  local: StorageSandbox;
  session: StorageSandbox;
  /** 提前还原真实存储；通常不必调用，测试结束会自动还原。 */
  uninstall(): void;
}

/**
 * 安装本地存储沙箱：每个测试拿到干净的 localStorage / sessionStorage，
 * 并可注入写入失败，用于验证草稿保存失败时的提示与降级。
 */
export function installStorageSandbox(): StorageSandboxes {
  const localDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const sessionDescriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");

  const local = createStore();
  const session = createStore();

  Object.defineProperty(window, "localStorage", { configurable: true, get: () => local.storage });
  Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => session.storage });

  let installed = true;
  const uninstall = () => {
    if (!installed) return;
    installed = false;
    restore(window, "localStorage", localDescriptor);
    restore(window, "sessionStorage", sessionDescriptor);
  };
  registerTeardown(uninstall);

  return { local: local.sandbox, session: session.sandbox, uninstall };
}

function createStore(): { storage: Storage; sandbox: StorageSandbox } {
  const entries = new Map<string, string>();
  let failureName: string | null = null;
  let writes = 0;

  const guardWrite = () => {
    if (!failureName) return;
    const error = new Error("本地存储写入失败");
    error.name = failureName;
    throw error;
  };

  const storage = {
    get length() {
      return entries.size;
    },
    key(index: number) {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key: string) {
      return entries.has(key) ? (entries.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      guardWrite();
      writes += 1;
      entries.set(String(key), String(value));
    },
    removeItem(key: string) {
      guardWrite();
      writes += 1;
      entries.delete(String(key));
    },
    clear() {
      guardWrite();
      writes += 1;
      entries.clear();
    }
  } as Storage;

  const sandbox: StorageSandbox = {
    seed(seeded) {
      for (const [key, value] of Object.entries(seeded)) entries.set(key, value);
    },
    snapshot: () => Object.fromEntries(entries),
    failWrites(errorName) {
      failureName = errorName;
    },
    writeCount: () => writes
  };

  return { storage, sandbox };
}

function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  delete (target as Record<string, unknown>)[key];
}
