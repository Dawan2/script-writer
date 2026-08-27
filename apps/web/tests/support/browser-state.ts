import { registerTeardown } from "./lifecycle";

export type VisibilityState = "visible" | "hidden";

export interface BrowserState {
  /** 断网：navigator.onLine 转为 false 并派发 offline 事件。 */
  goOffline(): void;
  /** 恢复联网：navigator.onLine 转为 true 并派发 online 事件。 */
  goOnline(): void;
  /** 切到后台标签页：visibilityState 转为 hidden 并派发 visibilitychange。 */
  hide(): void;
  /** 回到前台标签页：visibilityState 转为 visible 并派发 visibilitychange。 */
  show(): void;
  /** 触发关闭/刷新前的确认时机，返回事件对象供断言是否被拦截。 */
  triggerBeforeUnload(): BeforeUnloadEvent;
  isOnline(): boolean;
  visibility(): VisibilityState;
  /** 提前还原真实状态；通常不必调用，测试结束会自动还原。 */
  uninstall(): void;
}

export interface BrowserStateOptions {
  online?: boolean;
  visibility?: VisibilityState;
}

/**
 * 注入连接状态与页面可见性：让"断网重连""切后台停轮询"这类断言可以在测试里直接触发。
 */
export function installBrowserState(options: BrowserStateOptions = {}): BrowserState {
  let online = options.online ?? true;
  let visibility: VisibilityState = options.visibility ?? "visible";

  const onLineDescriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
  const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");

  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => visibility === "hidden" });

  let installed = true;
  const uninstall = () => {
    if (!installed) return;
    installed = false;
    restore(navigator, "onLine", onLineDescriptor);
    restore(document, "visibilityState", visibilityDescriptor);
    restore(document, "hidden", hiddenDescriptor);
  };
  registerTeardown(uninstall);

  const setOnline = (next: boolean) => {
    online = next;
    window.dispatchEvent(new Event(next ? "online" : "offline"));
  };
  const setVisibility = (next: VisibilityState) => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };

  return {
    goOffline: () => setOnline(false),
    goOnline: () => setOnline(true),
    hide: () => setVisibility("hidden"),
    show: () => setVisibility("visible"),
    triggerBeforeUnload() {
      const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
      window.dispatchEvent(event);
      return event;
    },
    isOnline: () => online,
    visibility: () => visibility,
    uninstall
  };
}

function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  delete (target as Record<string, unknown>)[key];
}
