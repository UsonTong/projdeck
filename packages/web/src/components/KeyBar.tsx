import { KeyboardIcon, PaperclipIcon } from "lucide-react";
import type { PointerEvent, ReactNode, RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TerminalHandle } from "./GhosttyTerminal.tsx";

type Key = { label: ReactNode; title: string; seq: (h: TerminalHandle) => string };

const arrow = (c: string) => (h: TerminalHandle) => (h.appCursor() ? `\x1bO${c}` : `\x1b[${c}`);

/** 手机软键盘上没有的按键。直接以原始字节发送到终端。 */
const KEYS: Key[] = [
  { label: "esc", title: "Esc", seq: () => "\x1b" },
  { label: "tab", title: "Tab", seq: () => "\t" },
  { label: "⇧tab", title: "Shift+Tab（切换 Claude 模式）", seq: () => "\x1b[Z" },
  { label: "↑", title: "上", seq: arrow("A") },
  { label: "↓", title: "下", seq: arrow("B") },
  { label: "←", title: "左", seq: arrow("D") },
  { label: "→", title: "右", seq: arrow("C") },
  { label: "^C", title: "Ctrl+C（中断）", seq: () => "\x03" },
  { label: "/", title: "/", seq: () => "/" },
  { label: "|", title: "|", seq: () => "|" },
  { label: "~", title: "~", seq: () => "~" },
];

/** pointerdown + preventDefault：点按钮不会让终端失去焦点，软键盘保持弹出。 */
const press = (fn: () => void) => (e: PointerEvent) => {
  e.preventDefault();
  fn();
};

/**
 * 终端下方的键盘辅助栏（类似 Termius / Blink 的 accessory bar）。
 */
export function KeyBar(props: {
  term: RefObject<TerminalHandle | null>;
  showKeys: boolean;
  ctrl: boolean;
  composerOpen: boolean;
  onToggleComposer: () => void;
  onPickFile: () => void;
}) {
  const sendKey = (k: Key) => () => {
    const h = props.term.current;
    if (h) h.send(k.seq(h));
  };

  return (
    <div className="flex items-center gap-1.5 border-t bg-card px-1.5 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] select-none">
      {props.showKeys && (
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Button
            variant={props.ctrl ? "default" : "secondary"}
            className="h-9 min-w-10 shrink-0 touch-manipulation px-2.5 font-mono text-[13px]"
            aria-pressed={props.ctrl}
            title="Ctrl：下一个输入的字母按 Ctrl 组合发送"
            onPointerDown={press(() => props.term.current?.armCtrl(!props.ctrl))}
          >
            ctrl
          </Button>
          {KEYS.map((k) => (
            <Button
              key={k.title}
              variant="secondary"
              title={k.title}
              className="h-9 min-w-10 shrink-0 touch-manipulation px-2.5 font-mono text-[13px]"
              onPointerDown={press(sendKey(k))}
            >
              {k.label}
            </Button>
          ))}
        </div>
      )}
      {props.showKeys && <Separator orientation="vertical" className="h-6" />}
      <div className={cn("flex shrink-0 gap-1", !props.showKeys && "ml-auto")}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-lg" aria-label="上传文件" onPointerDown={press(props.onPickFile)}>
              <PaperclipIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>上传图片或文件，把路径粘贴到终端（也可以直接粘贴或拖进终端）</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={props.composerOpen ? "secondary" : "ghost"}
              size="icon-lg"
              aria-label="输入框"
              aria-pressed={props.composerOpen}
              onPointerDown={press(props.onToggleComposer)}
            >
              <KeyboardIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>输入框：适合长文本、中文输入法和图片附件</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
