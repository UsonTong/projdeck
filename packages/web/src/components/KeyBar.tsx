import type { PointerEvent, ReactNode, RefObject } from "react";
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

/**
 * 终端下方的键盘辅助栏（类似 Termius / Blink 的 accessory bar）。
 * 用 pointerdown + preventDefault 触发：点按钮不会让终端失去焦点，软键盘保持弹出。
 */
export function KeyBar(props: {
  term: RefObject<TerminalHandle | null>;
  showKeys: boolean;
  ctrl: boolean;
  composerOpen: boolean;
  onToggleComposer: () => void;
  onPickImage: () => void;
}) {
  const press = (fn: () => void) => (e: PointerEvent) => {
    e.preventDefault();
    fn();
  };
  const sendKey = (k: Key) => () => {
    const h = props.term.current;
    if (h) h.send(k.seq(h));
  };

  return (
    <div className="keybar">
      {props.showKeys && (
        <div className="keybar-keys">
          <button
            className={props.ctrl ? "on" : ""}
            title="Ctrl：下一个输入的字母按 Ctrl 组合发送"
            onPointerDown={press(() => props.term.current?.armCtrl(!props.ctrl))}
          >
            ctrl
          </button>
          {KEYS.map((k) => (
            <button key={k.title} title={k.title} onPointerDown={press(sendKey(k))}>
              {k.label}
            </button>
          ))}
        </div>
      )}
      <div className="keybar-actions">
        <button title="发送图片：上传后把路径粘贴到终端" onPointerDown={press(props.onPickImage)}>
          <ImageIcon />
        </button>
        <button
          className={props.composerOpen ? "on" : ""}
          title="输入框：适合长文本和中文输入法"
          onPointerDown={press(props.onToggleComposer)}
        >
          <KeyboardIcon />
        </button>
      </div>
    </div>
  );
}

export function ImageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m21 16-5-5-9 9" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  );
}
