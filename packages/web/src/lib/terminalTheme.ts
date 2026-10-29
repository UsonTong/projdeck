import type { TerminalTheme } from "@projdeck/shared";
import { useSyncExternalStore } from "react";
import { api } from "../api.ts";

/** 读取不到本机 Ghostty 配置时使用（Ghostty 默认配色）。 */
const FALLBACK_THEME: TerminalTheme = {
  source: "default",
  fontFamily: [],
  fontSizePx: 16,
  background: "#282c34",
  foreground: "#ffffff",
  cursor: "#ffffff",
  cursorText: "#282c34",
  selectionBackground: "#ffffff",
  selectionForeground: "#282c34",
  palette: [
    "#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6",
    "#666666", "#d54e53", "#b9ca4a", "#e7c547", "#7aa6da", "#c397d8", "#70c0b1", "#eaeaea",
  ],
  paddingX: 2,
  paddingY: 2,
};

let current: TerminalTheme | null = null;
let loading = false;
let lastFetch = 0;
const listeners = new Set<() => void>();

/**
 * 从 agentd 读取本机 Ghostty 的主题。像 dankcolors 这类按壁纸生成的主题会变化，
 * 本机配色一变，agentd 会推送通知（见 live.ts），这里立即重新获取；切回前台时也会检查（至少间隔 30 秒）。
 * 变了才通知界面更新。
 */
export function refreshTheme(force = false): void {
  if (loading || (!force && Date.now() - lastFetch < 30_000)) return;
  loading = true;
  lastFetch = Date.now();
  api
    .terminalTheme()
    .catch(() => FALLBACK_THEME)
    .then((theme) => {
      loading = false;
      if (JSON.stringify(theme) === JSON.stringify(current)) return;
      current = theme;
      applyAppTheme(theme);
      listeners.forEach((l) => l());
    });
}

let started = false;
function start(): void {
  if (started) return;
  started = true;
  refreshTheme();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshTheme());
  window.addEventListener("focus", () => refreshTheme());
}

/** 当前的终端主题；首次加载完成前为 null。整个界面的配色也随之同步（见 applyAppTheme）。 */
export function useTerminalTheme(): TerminalTheme | null {
  start();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** 主题的指纹：终端在主题变化时用它重新挂载。 */
export const themeKey = (t: TerminalTheme) => `${t.background}${t.foreground}${t.palette.join("")}`;

/**
 * 让整个界面与终端同一套配色：把 shadcn 的颜色变量改为由 Ghostty 前景 / 背景色按比例混合得到。
 * 这样卡片、边框、悬停、滚动条都是终端背景的同色系，不会出现两种黑。
 */
function applyAppTheme(t: TerminalTheme): void {
  const fg = t.foreground;
  const bg = t.background;
  const mix = (pct: number) => `color-mix(in oklab, ${fg} ${pct}%, ${bg})`;
  const vars: Record<string, string> = {
    "--background": bg,
    "--foreground": fg,
    "--card": mix(4),
    "--card-foreground": fg,
    "--popover": mix(6),
    "--popover-foreground": fg,
    "--primary": fg,
    "--primary-foreground": bg,
    "--secondary": mix(10),
    "--secondary-foreground": fg,
    "--muted": mix(9),
    "--muted-foreground": mix(58),
    "--accent": mix(11),
    "--accent-foreground": fg,
    "--destructive": t.palette[1] ?? "#e06c75",
    "--border": mix(13),
    "--input": mix(17),
    "--ring": mix(40),
    "--scrollbar": mix(22),
    // 状态色取终端调色板，与 Claude / Codex 在终端里用的颜色一致
    "--status-working": t.palette[3] ?? "#e5c07b",
    "--status-blocked": t.palette[1] ?? "#e06c75",
    "--status-done": t.palette[2] ?? "#98c379",
  };
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
}
