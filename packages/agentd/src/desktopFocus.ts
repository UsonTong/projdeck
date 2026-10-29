import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Ghostty 在 niri 里的 app_id。 */
const GHOSTTY_APP_ID = "com.mitchellh.ghostty";
const RETRY_MS = 5_000;

/** niri 的 IPC socket：优先用环境变量，否则在运行时目录里找（agentd 开机启动时还没有图形会话的环境变量）。 */
function findNiriSocket(): string | null {
  const fromEnv = process.env.NIRI_SOCKET;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const dir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  try {
    const socks = readdirSync(dir)
      .filter((n) => /^niri\..*\.sock$/.test(n))
      .map((n) => join(dir, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return socks[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 电脑上的 Ghostty 什么时候被切到前台（读 niri 的事件流）。
 * 网页终端的「自动」尺寸据此判断电脑上的 herdr 是否正在被使用：只认电脑上真正的窗口切换，
 * 网页失去焦点（例如在另一台电脑上点了任务栏）不算。不是 niri 桌面时不工作，电脑一直不算在用。
 */
export class DesktopFocus extends EventEmitter<{ change: [] }> {
  /** 最近一次 Ghostty 窗口获得焦点的时间（0 = 从未）。 */
  focusedAt = 0;
  private ghosttyFocused = false;
  private readonly windows = new Map<number, string>(); // 窗口 id → app_id
  private child: ChildProcess | null = null;
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;

  start(): void {
    const socket = findNiriSocket();
    if (!socket) {
      this.retry = setTimeout(() => this.start(), RETRY_MS * 6);
      return;
    }
    const child = spawn("niri", ["msg", "--json", "event-stream"], {
      env: { ...process.env, NIRI_SOCKET: socket },
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.child = child;
    child.on("error", () => {}); // 没装 niri
    createInterface({ input: child.stdout! }).on("line", (line) => this.handle(line));
    child.on("exit", () => {
      this.child = null;
      if (!this.stopped) this.retry = setTimeout(() => this.start(), RETRY_MS);
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.child?.kill();
  }

  /** 处理 niri 事件流的一行（JSON）。 */
  handle(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    type Win = { id: number; app_id: string | null; is_focused: boolean };
    if (event.WindowsChanged) {
      const { windows } = event.WindowsChanged as { windows: Win[] };
      this.windows.clear();
      for (const w of windows) this.windows.set(w.id, w.app_id ?? "");
      this.setFocused(windows.find((w) => w.is_focused)?.id ?? null);
    } else if (event.WindowOpenedOrChanged) {
      const { window } = event.WindowOpenedOrChanged as { window: Win };
      this.windows.set(window.id, window.app_id ?? "");
      if (window.is_focused) this.setFocused(window.id);
    } else if (event.WindowClosed) {
      this.windows.delete((event.WindowClosed as { id: number }).id);
    } else if (event.WindowFocusChanged) {
      this.setFocused((event.WindowFocusChanged as { id: number | null }).id);
    }
  }

  private setFocused(id: number | null): void {
    const ghostty = id !== null && this.windows.get(id) === GHOSTTY_APP_ID;
    if (ghostty && !this.ghosttyFocused) {
      this.focusedAt = Date.now();
      this.emit("change");
    }
    this.ghosttyFocused = ghostty;
  }
}
