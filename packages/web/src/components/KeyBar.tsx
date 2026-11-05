import { PaperclipIcon } from "lucide-react";
import { Keyboard, X } from "lucide";
import { MorphIcon } from "morphicons/react";
import { useEffect, useRef, type PointerEvent, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type BarKey, useBarKeys } from "@/lib/keybar";
import { cn } from "@/lib/utils";
import type { TerminalHandle } from "./GhosttyTerminal.tsx";

/** 按住多久开始连发、连发间隔。 */
const REPEAT_DELAY_MS = 400;
const REPEAT_MS = 70;

/**
 * 快捷键条上一个键的按下处理。pointerdown 里 preventDefault：不让终端失去焦点，软键盘保持弹出。
 * 松手才发送：按住横向滑动是在滚动快捷键条，不算按键（浏览器接管滚动时会触发 pointercancel）。
 * 方向键等按住连发。
 */
function useKeyPress(fire: (k: BarKey) => void) {
  const state = useRef<{ x: number; repeated: boolean; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const stop = () => {
    clearTimeout(state.current?.timer);
    clearInterval(state.current?.timer);
    state.current = null;
  };
  useEffect(() => stop, []);
  return (k: BarKey) => ({
    onPointerDown(e: PointerEvent) {
      e.preventDefault();
      stop();
      const s: NonNullable<typeof state.current> = { x: e.clientX, repeated: false };
      if (k.repeat)
        s.timer = setTimeout(() => {
          s.repeated = true;
          fire(k);
          s.timer = setInterval(() => fire(k), REPEAT_MS);
        }, REPEAT_DELAY_MS);
      state.current = s;
    },
    onPointerMove(e: PointerEvent) {
      if (state.current && !state.current.repeated && Math.abs(e.clientX - state.current.x) > 8) stop();
    },
    onPointerUp() {
      if (state.current && !state.current.repeated) fire(k);
      stop();
    },
    onPointerCancel: stop,
    onPointerLeave: stop,
  });
}

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
  onToggleComposer?: () => void;
  onPickFile?: () => void;
}) {
  const keys = useBarKeys();
  const keyPress = useKeyPress((k) => {
    const h = props.term.current;
    if (!h) return;
    if (k.seq) h.send(k.seq(h));
    else h.armCtrl(!props.ctrl);
  });

  return (
    <div className="flex items-center gap-1.5 border-t bg-card px-1.5 pt-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] select-none">
      {props.showKeys && keys.length > 0 && (
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {keys.map((k) => (
            <Button
              key={k.id}
              variant={k.id === "ctrl" && props.ctrl ? "default" : "secondary"}
              title={k.title}
              aria-pressed={k.id === "ctrl" ? props.ctrl : undefined}
              className="h-9 min-w-10 shrink-0 touch-manipulation px-2.5 font-mono text-[13px]"
              {...keyPress(k)}
            >
              {k.label}
            </Button>
          ))}
        </div>
      )}
      {props.showKeys && keys.length > 0 && <Separator orientation="vertical" className="h-6" />}
      <div className={cn("flex shrink-0 gap-1", !props.showKeys && "ml-auto")}>
        {props.onPickFile && <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-lg" aria-label="上传文件" onPointerDown={press(props.onPickFile)}>
              <PaperclipIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>上传图片或文件，把路径粘贴到终端（也可以直接粘贴或拖进终端）</TooltipContent>
        </Tooltip>}
        {props.onToggleComposer && <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={props.composerOpen ? "secondary" : "ghost"}
              size="icon-lg"
              aria-label="输入框"
              aria-pressed={props.composerOpen}
              onPointerDown={press(props.onToggleComposer)}
            >
              <MorphIcon icon={props.composerOpen ? X : Keyboard} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>输入框：适合长文本、中文输入法和图片附件</TooltipContent>
        </Tooltip>}
      </div>
    </div>
  );
}
