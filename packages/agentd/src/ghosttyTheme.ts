import { execFile } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TerminalTheme } from "@projdeck/shared";

const run = promisify(execFile);

/** Ghostty 自带主题（Ghostty Default Style Dark）的配色，本机没有 Ghostty 时使用。 */
export const DEFAULT_THEME: TerminalTheme = {
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

const HEX = /^#?[0-9a-fA-F]{6}$/;
const hex = (v: string | undefined) => (v && HEX.test(v) ? (v.startsWith("#") ? v : `#${v}`) : undefined);

/** 解析 `ghostty +show-config` 的输出（每行 `key = value`，palette 为 `palette = N=#rrggbb`）。 */
export function parseGhosttyConfig(text: string): TerminalTheme {
  const theme: TerminalTheme = { ...DEFAULT_THEME, palette: [...DEFAULT_THEME.palette], fontFamily: [], source: "ghostty" };
  let cursorSet = false;
  let selectionFgSet = false;
  let cursorTextSet = false;

  for (const line of text.split("\n")) {
    const m = /^([a-z0-9-]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    const value = raw.trim().replace(/^"(.*)"$/, "$1");
    switch (key) {
      case "font-family":
        if (value) theme.fontFamily.push(value);
        break;
      case "font-size": {
        const pt = Number(value);
        // Ghostty 的字号单位是 pt，按 96 DPI 换算为 px
        if (pt > 0) theme.fontSizePx = Math.round(((pt * 96) / 72) * 2) / 2;
        break;
      }
      case "background":
        theme.background = hex(value) ?? theme.background;
        break;
      case "foreground":
        theme.foreground = hex(value) ?? theme.foreground;
        break;
      case "cursor-color":
        if (hex(value)) {
          theme.cursor = hex(value)!;
          cursorSet = true;
        }
        break;
      case "cursor-text":
        if (hex(value)) {
          theme.cursorText = hex(value)!;
          cursorTextSet = true;
        }
        break;
      case "selection-background":
        theme.selectionBackground = hex(value) ?? theme.selectionBackground;
        break;
      case "selection-foreground":
        if (hex(value)) {
          theme.selectionForeground = hex(value)!;
          selectionFgSet = true;
        }
        break;
      case "palette": {
        const p = /^(\d+)=(.+)$/.exec(value);
        if (p && Number(p[1]) < 16 && hex(p[2])) theme.palette[Number(p[1])] = hex(p[2])!;
        break;
      }
      case "window-padding-x":
        theme.paddingX = Number(value.split(",")[0]) || 0;
        break;
      case "window-padding-y":
        theme.paddingY = Number(value.split(",")[0]) || 0;
        break;
    }
  }
  // 与 Ghostty 一致：未单独设置时，光标用前景色，光标下文字和选区文字用背景色
  if (!cursorSet) theme.cursor = theme.foreground;
  if (!cursorTextSet) theme.cursorText = theme.background;
  if (!selectionFgSet) theme.selectionForeground = theme.background;
  return theme;
}

let cache: { at: number; theme: TerminalTheme } | undefined;

/** 读取本机 Ghostty 的最终配置（含主题展开后的颜色），结果缓存 60 秒。 */
export async function loadGhosttyTheme(ghosttyBin = "ghostty"): Promise<TerminalTheme> {
  if (cache && Date.now() - cache.at < 60_000) return cache.theme;
  let theme: TerminalTheme;
  try {
    const { stdout } = await run(ghosttyBin, ["+show-config"], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    theme = parseGhosttyConfig(stdout);
  } catch {
    theme = DEFAULT_THEME;
  }
  cache = { at: Date.now(), theme };
  return theme;
}

/**
 * 监听 Ghostty 配置目录（含 themes/），变化时清掉缓存并通知。
 * dankcolors 这类主题随壁纸重新生成主题文件，网页要立刻跟着变，不能等页面切回前台。
 */
export function watchGhosttyTheme(onChange: () => void): () => void {
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ghostty");
  if (!existsSync(dir)) return () => {};
  let timer: NodeJS.Timeout | undefined;
  // 生成主题时往往连写好几次，停下来 300ms 再通知
  const watcher = watch(dir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      cache = undefined;
      onChange();
    }, 300);
  });
  watcher.on("error", () => {});
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
