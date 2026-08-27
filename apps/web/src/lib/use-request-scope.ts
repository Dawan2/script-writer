"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import { isRequestCancelled } from "@/lib/request-core";

/**
 * 把一个组件的在途请求绑在它的生命周期上：组件卸载或用户切走时取消请求，
 * 并且不再回写状态——取消不是失败，界面上不该留下任何提示。
 */
export interface RequestScope {
  /** 传给接口函数末位选项的取消信号。 */
  readonly signal: AbortSignal;
  /**
   * 跑一次请求。已取消或组件已卸载时返回 undefined 且不调用 apply；
   * 其余失败照常抛出，交给调用方按错误码处理。
   */
  run<T>(task: (signal: AbortSignal) => Promise<T>, apply?: (value: T) => void): Promise<T | undefined>;
}

export function useRequestScope(): RequestScope {
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const controller = useCallback(() => {
    if (controllerRef.current === null || controllerRef.current.signal.aborted) {
      controllerRef.current = new AbortController();
    }
    return controllerRef.current;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const run = useCallback(
    async <T,>(task: (signal: AbortSignal) => Promise<T>, apply?: (value: T) => void) => {
      try {
        const value = await task(controller().signal);
        if (!mountedRef.current) return undefined;
        apply?.(value);
        return value;
      } catch (error) {
        if (isRequestCancelled(error) || !mountedRef.current) return undefined;
        throw error;
      }
    },
    [controller]
  );

  return useMemo(
    () => ({
      get signal() {
        return controller().signal;
      },
      run
    }),
    [controller, run]
  );
}
