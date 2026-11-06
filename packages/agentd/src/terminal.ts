import type { IPty } from "node-pty";
import pty from "node-pty";
import type { WebSocket } from "ws";
import type { Config } from "./config.ts";
import { desktopClientConnected } from "./desktop.ts";
import type { DesktopFocus } from "./desktopFocus.ts";
import type { ProjdeckService } from "./service.ts";

/** 同时打开的网页终端上限，防止忘关的标签页无限占用 PTY。 */
const MAX_TERMINALS = 12;
/** WebSocket 发送缓冲超过此值时暂停读取 PTY，避免慢网络下内存堆积。 */
const HIGH_WATER = 2 * 1024 * 1024;

/** a：网页刚被操作过（获得焦点、点击、按键）。 */
type ClientFrame = { t: "i"; d: string } | { t: "r"; c: number; r: number } | { t: "a"; active: boolean };
type ServerFrame =
  | { t: "error"; message: string }
  | { t: "exit" }
  /** follow 不为空：跟随电脑上的尺寸，网页按这个行列数显示并缩放字号；为空：网页自己决定尺寸。 */
  | { t: "size"; follow: { cols: number; rows: number } | null };

/**
 * 网页终端的尺寸策略。
 * - fit：pane 改为网页的尺寸（手机等，电脑上的 herdr 会被裁切）；
 * - desktop：保持电脑上的尺寸，网页缩放显示；
 * - auto：谁最近在操作谁优先。网页被操作后适配网页；电脑上切到 Ghostty（niri 报告的窗口焦点切换）后，
 *   且电脑上开着 herdr 客户端时，恢复电脑上的尺寸。网页只是失去焦点（例如在另一台电脑上点了任务栏）不算。
 */
export type TerminalSizing = "fit" | "desktop" | "auto";

/** 跟随电脑时多久检查一次电脑上的尺寸（窗口改变大小、关掉 herdr 客户端）。 */
const FOLLOW_POLL_MS = 2_000;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(n) || min));

/**
 * 网页终端：每个 WebSocket 对应一个 PTY，PTY 里运行 `herdr terminal attach <terminal_id>`。
 * 用 terminal attach 而不是 agent attach：前者对 agent 和普通 shell pane 都适用。
 *
 * 不使用 --takeover：电脑上的 herdr TUI 与网页可以同时连接（已验证）。
 * attach 期间 pane 尺寸由 attach 客户端决定（herdr 锁定尺寸，电脑上的布局只能裁切显示），断开后恢复。
 * 所以电脑上也在看时，按电脑上的尺寸 attach（见 TerminalSizing），网页缩放显示。
 *
 * attach 客户端把 Ctrl+B 当作前缀键（Ctrl+B q 断开），网页发来的 Ctrl+B 一律转义为 Ctrl+B Ctrl+B，
 * 由 herdr 还原为一个字面的 Ctrl+B，避免用户按键意外断开连接。
 *
 * 帧格式：服务端 → 客户端，二进制帧为终端原始输出，文本帧为 JSON 控制消息；
 * 客户端 → 服务端，文本帧 JSON：{t:"i",d} 输入，{t:"r",c,r} 改变尺寸。
 */
export class TerminalBridge {
  private readonly config: Config;
  private readonly service: ProjdeckService;
  private readonly active = new Set<IPty>();
  /** terminalId → 一条共享的 herdr attach；多个网页/手机视图复用，避免 herdr 的「已有客户端」错误。 */
  private readonly shared = new Map<string, Shared>();

  private readonly desktopFocus: DesktopFocus;

  constructor(config: Config, service: ProjdeckService, desktopFocus: DesktopFocus) {
    this.config = config;
    this.service = service;
    this.desktopFocus = desktopFocus;
  }

  async open(
    ws: WebSocket,
    paneId: string,
    cols: number,
    rows: number,
    sizing: TerminalSizing = "fit",
    initiallyActive = true,
  ): Promise<void> {
    if (this.active.size >= MAX_TERMINALS) {
      this.control(ws, { t: "error", message: "打开的终端太多了，请先关闭一些页面" });
      return ws.close();
    }
    let terminalId: string;
    try {
      terminalId = await this.service.terminalIdOf(paneId);
    } catch (err) {
      this.control(ws, { t: "error", message: (err as Error).message });
      return ws.close();
    }
    if (ws.readyState !== ws.OPEN) return;

    const existing = this.shared.get(terminalId);
    if (existing) {
      this.join(existing, ws, paneId);
      return;
    }

    // 去掉 HERDR_* 变量：agentd 自己可能运行在某个 herdr pane 里，避免被当成嵌套客户端或连错 socket
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("HERDR_") && k !== "TERM_PROGRAM") env[k] = v;
    }
    env.HERDR_SOCKET_PATH = this.config.herdrSocket;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";

    const webActiveAt = { value: initiallyActive ? Date.now() : 0 };
    const desired = async () => {
      if (sizing === "fit") return null;
      if (sizing === "auto" && webActiveAt.value >= this.desktopFocus.focusedAt) return null;
      if (sizing === "auto" && !(await desktopClientConnected(this.config.herdrSocket))) return null;
      return this.service.desktopSize(paneId).catch(() => null);
    };
    const follow = await desired();
    if (ws.readyState !== ws.OPEN) return;
    const web = { cols: clamp(cols, 20, 500), rows: clamp(rows, 5, 200) };
    const target = () => (shared.follow ?? shared.web);

    const term = pty.spawn(this.config.herdrBin, ["terminal", "attach", terminalId], {
      name: "xterm-256color",
      cols: (follow ?? web).cols,
      rows: (follow ?? web).rows,
      cwd: process.env.HOME,
      env,
      encoding: null,
    });
    this.active.add(term);

    const shared: Shared = {
      paneId,
      terminalId,
      term,
      clients: new Set(),
      follow,
      web,
      webActiveAt: webActiveAt.value,
      sizing,
      started: false,
      update: async () => {},
      poll: undefined,
      onDesktopFocus: () => {},
      endView: undefined,
    };
    this.shared.set(terminalId, shared);

    // 打开网页终端即算看过这个会话；最后一个视图离开时才结束
    const viewing = this.service.beginView(paneId).catch(() => () => {});
    shared.endView = () => void viewing.then((end) => end());

    shared.update = async () => {
      const next = await desired();
      if (JSON.stringify(next) === JSON.stringify(shared.follow)) return;
      shared.follow = next;
      term.resize(target().cols, target().rows);
      this.broadcast(shared, JSON.stringify({ t: "size", follow: shared.follow }));
    };
    shared.poll = setInterval(() => void shared.update(), FOLLOW_POLL_MS);
    shared.onDesktopFocus = () => void shared.update();
    this.desktopFocus.on("change", shared.onDesktopFocus);

    term.onData((data) => {
      const buf = data as unknown as Buffer;
      if (!shared.started) {
        shared.started = true;
        const head = buf.subarray(0, 300).toString("utf8");
        if (head.startsWith('{"error"')) {
          const message = /"message":"([^"]*)"/.exec(head)?.[1] ?? head;
          this.broadcast(shared, JSON.stringify({ t: "error", message: `无法连接终端：${message}` }));
          return;
        }
      }
      for (const client of shared.clients) {
        if (client.readyState !== client.OPEN) continue;
        client.send(buf, { binary: true });
        if (client.bufferedAmount > HIGH_WATER) {
          term.pause();
          const resume = setInterval(() => {
            if (client.readyState !== client.OPEN || client.bufferedAmount < HIGH_WATER / 4) {
              clearInterval(resume);
              term.resume();
            }
          }, 50);
        }
      }
    });

    term.onExit(() => {
      clearInterval(shared.poll);
      this.desktopFocus.off("change", shared.onDesktopFocus);
      this.active.delete(term);
      this.shared.delete(terminalId);
      this.broadcast(shared, JSON.stringify({ t: "exit" }));
      for (const client of shared.clients) client.close();
      shared.clients.clear();
      this.finishView(shared);
    });

    this.control(ws, { t: "size", follow: shared.follow });
    this.bind(shared, ws, cols, rows);
  }

  /** 第二个及之后的网页/手机视图：复用同一条 attach，并补当前屏幕。 */
  private join(shared: Shared, ws: WebSocket, paneId: string): void {
    if (ws.readyState !== ws.OPEN) return;
    this.control(ws, { t: "size", follow: shared.follow });
    this.bind(shared, ws, shared.web.cols, shared.web.rows);
    void this.service
      .terminalSnapshot(paneId)
      .then((text) => {
        if (ws.readyState === ws.OPEN && text) ws.send(Buffer.from(text), { binary: true });
      })
      .catch(() => {});
  }

  private bind(shared: Shared, ws: WebSocket, cols: number, rows: number): void {
    shared.clients.add(ws);
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw)) as ClientFrame;
      } catch {
        return;
      }
      if (frame.t === "i" && typeof frame.d === "string") shared.term.write(frame.d.replaceAll("\x02", "\x02\x02"));
      if (frame.t === "a" && frame.active === true) {
        shared.webActiveAt = Date.now();
        void shared.update();
      }
      if (frame.t === "r") {
        shared.web = { cols: clamp(frame.c, 20, 500), rows: clamp(frame.r, 5, 200) };
        if (!shared.follow) shared.term.resize(shared.web.cols, shared.web.rows);
      }
    });
    ws.on("close", () => this.leave(shared, ws));
    ws.on("error", () => this.leave(shared, ws));
    // 首次打开的视图尺寸已经是最新的；第二个视图沿用共享尺寸，仅记录它的行列用于后续操作
    void cols;
    void rows;
  }

  private leave(shared: Shared, ws: WebSocket): void {
    if (!shared.clients.has(ws)) return;
    shared.clients.delete(ws);
    if (shared.clients.size > 0) return;
    clearInterval(shared.poll);
    this.desktopFocus.off("change", shared.onDesktopFocus);
    this.shared.delete(shared.terminalId);
    if (this.active.delete(shared.term)) shared.term.kill();
    this.finishView(shared);
  }

  private finishView(shared: Shared): void {
    const end = shared.endView;
    shared.endView = undefined;
    end?.();
  }

  private control(ws: WebSocket, msg: ServerFrame): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(shared: Shared, text: string): void {
    for (const client of shared.clients) if (client.readyState === client.OPEN) client.send(text);
  }

  closeAll(): void {
    for (const shared of this.shared.values()) {
      clearInterval(shared.poll);
      this.desktopFocus.off("change", shared.onDesktopFocus);
      this.finishView(shared);
      for (const client of shared.clients) client.close();
      shared.clients.clear();
      shared.term.kill();
    }
    this.shared.clear();
    this.active.clear();
  }
}

interface Shared {
  paneId: string;
  terminalId: string;
  term: IPty;
  clients: Set<WebSocket>;
  follow: { cols: number; rows: number } | null;
  web: { cols: number; rows: number };
  webActiveAt: number;
  sizing: TerminalSizing;
  started: boolean;
  update: () => Promise<void>;
  poll: ReturnType<typeof setInterval> | undefined;
  onDesktopFocus: () => void;
  endView: (() => void) | undefined;
}
