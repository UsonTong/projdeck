import { setDevicePref, useDevicePref } from "@/lib/devicePrefs";

/** 终端里需要知道的状态：方向键在应用光标模式（DECCKM）下要用 ESC O 前缀。 */
export interface KeyTarget {
  appCursor(): boolean;
}

export interface BarKey {
  id: string;
  label: string;
  title: string;
  /** 发送的原始字节。ctrl 是粘滞键，没有 seq。 */
  seq?: (t: KeyTarget) => string;
  /** 按住连发（方向键、翻页）。 */
  repeat?: boolean;
}

const arrow = (c: string) => (t: KeyTarget) => (t.appCursor() ? `\x1bO${c}` : `\x1b[${c}`);
const ctrlKey = (letter: string, hint: string): BarKey => ({
  id: `^${letter}`,
  label: `^${letter}`,
  title: `Ctrl+${letter}（${hint}）`,
  seq: () => String.fromCharCode(letter.charCodeAt(0) & 0x1f),
});
const char = (c: string): BarKey => ({ id: c, label: c, title: c, seq: () => c });

/** 可以放进快捷键条的键，按这个顺序显示。 */
export const BAR_KEYS: BarKey[] = [
  { id: "ctrl", label: "ctrl", title: "Ctrl：下一个输入的字母按 Ctrl 组合发送" },
  { id: "esc", label: "esc", title: "Esc（Claude / Codex：打断）", seq: () => "\x1b" },
  { id: "tab", label: "tab", title: "Tab", seq: () => "\t" },
  { id: "stab", label: "⇧tab", title: "Shift+Tab（切换 Claude 模式）", seq: () => "\x1b[Z" },
  { id: "up", label: "↑", title: "上", seq: arrow("A"), repeat: true },
  { id: "down", label: "↓", title: "下", seq: arrow("B"), repeat: true },
  { id: "left", label: "←", title: "左", seq: arrow("D"), repeat: true },
  { id: "right", label: "→", title: "右", seq: arrow("C"), repeat: true },
  { id: "enter", label: "⏎", title: "回车（确认选项）", seq: () => "\r" },
  { id: "home", label: "home", title: "Home", seq: () => "\x1b[H" },
  { id: "end", label: "end", title: "End", seq: () => "\x1b[F" },
  { id: "pgup", label: "pgup", title: "Page Up", seq: () => "\x1b[5~", repeat: true },
  { id: "pgdn", label: "pgdn", title: "Page Down", seq: () => "\x1b[6~", repeat: true },
  ctrlKey("C", "中断"),
  ctrlKey("D", "退出 / 输入结束"),
  ctrlKey("L", "清屏"),
  ctrlKey("R", "搜索历史"),
  ctrlKey("O", "Claude：展开详细记录"),
  ctrlKey("T", "Claude：待办列表"),
  ctrlKey("B", "Claude：放到后台运行"),
  ...["/", "|", "~", "-", "_", "@", "!", "#", "*", "`", "\\", "$", "&", ">", "<", "=", ":"].map(char),
];

export const DEFAULT_BAR_KEYS = ["ctrl", "esc", "tab", "stab", "up", "down", "left", "right", "enter", "^C", "/", "|", "~"];

const PREF = "keyBar";

/** 这台设备上快捷键条显示的键（按 BAR_KEYS 的顺序）。 */
export function useBarKeys(): BarKey[] {
  const raw = useDevicePref(PREF, DEFAULT_BAR_KEYS.join(" "));
  const ids = new Set(raw.split(" "));
  return BAR_KEYS.filter((k) => ids.has(k.id));
}

export function setBarKeys(ids: string[] | null): void {
  setDevicePref(PREF, (ids ?? DEFAULT_BAR_KEYS).join(" "));
}
