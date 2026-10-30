import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * 原地编辑一段文字（会话名称、项目备注）：回车或点别处保存，Esc 取消。没改动时不保存。
 */
export function InlineInput(props: {
  label: string;
  initial: string;
  placeholder?: string;
  /** 保存（去掉首尾空白后的值，可能为空）。 */
  onSave: (value: string) => Promise<unknown>;
  onDone: () => void;
  className?: string;
}) {
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
    props.onSave(value).catch((err: Error) => toast.error(err.message));
  };

  return (
    <input
      ref={ref}
      defaultValue={props.initial}
      aria-label={props.label}
      placeholder={props.placeholder}
      className={cn("w-full min-w-0 rounded-md bg-background px-1.5 py-0.5 text-sm ring-1 ring-ring outline-none", props.className)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
