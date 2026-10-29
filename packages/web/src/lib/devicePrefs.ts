import { useSyncExternalStore } from "react";

/**
 * 只属于这台设备的偏好（存在 localStorage），例如终端尺寸策略：
 * 手机和电脑的屏幕不同，适合的设置也不同，所以不放进服务端的全局设置。
 * 同一页面里修改后立即通知所有使用者。
 */
const listeners = new Set<() => void>();
const keyOf = (key: string) => `projdeck:${key}`;

export function setDevicePref(key: string, value: string): void {
  localStorage.setItem(keyOf(key), value);
  listeners.forEach((l) => l());
}

export function useDevicePref<T extends string>(key: string, initial: T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (localStorage.getItem(keyOf(key)) as T | null) ?? initial,
  );
}

/** 网页终端的尺寸策略，见 agentd 的 TerminalSizing。 */
export type TerminalSizing = "auto" | "fit" | "desktop";
export const useTerminalSizing = () => useDevicePref<TerminalSizing>("termSizing", "auto");
