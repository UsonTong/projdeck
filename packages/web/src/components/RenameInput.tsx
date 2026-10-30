import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";

/**
 * 原地重命名会话：回车或点别处保存，Esc 取消；清空后保存恢复为 Claude / Codex 自动生成的标题。
 * 名字存在 herdr 里，电脑上的 herdr 侧栏同步显示。
 */
export function RenameInput(props: { paneId: string; initial: string; onDone: () => void; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    // 从菜单打开时菜单关闭后才能拿到焦点
    const t = setTimeout(() => ref.current?.select(), 0);
    return () => clearTimeout(t);
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    props.onDone();
    const value = ref.current?.value.trim() ?? "";
    if (!save || value === props.initial) return;
    api.rename(props.paneId, value || null).catch((err: Error) => toast.error(err.message));
  };

  return (
    <input
      ref={ref}
      defaultValue={props.initial}
      aria-label="会话名称"
      placeholder="留空恢复自动标题"
      className={cn("w-full min-w-0 rounded-md bg-background px-1.5 py-0.5 text-sm ring-1 ring-ring outline-none", props.className)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
