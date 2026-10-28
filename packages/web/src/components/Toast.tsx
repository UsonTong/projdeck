import { useCallback, useSyncExternalStore } from "react";

/** 全局轻提示：操作失败时在底部显示几秒。 */
let message: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function show(text: string): void {
  message = text;
  clearTimeout(timer);
  timer = setTimeout(() => {
    message = null;
    listeners.forEach((l) => l());
  }, 4000);
  listeners.forEach((l) => l());
}

export function useToast(): (text: string) => void {
  return useCallback(show, []);
}

export function ToastHost() {
  const text = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => message,
  );
  return text ? <div className="toast">{text}</div> : null;
}
