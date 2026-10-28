import type { IPty } from "node-pty";
import pty from "node-pty";
import type { WebSocket } from "ws";
import type { Config } from "./config.ts";
import type { ProjdeckService } from "./service.ts";

/** 同时打开的网页终端上限，防止忘关的标签页无限占用 PTY。 */
const MAX_TERMINALS = 12;
/** WebSocket 发送缓冲超过此值时暂停读取 PTY，避免慢网络下内存堆积。 */
const HIGH_WATER = 2 * 1024 * 1024;

type ClientFrame = { t: "i"; d: string } | { t: "r"; c: number; r: number };
type ServerFrame = { t: "error"; message: string } | { t: "exit" };

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(n) || min));

/**
 * 网页终端：每个 WebSocket 对应一个 PTY，PTY 里运行 `herdr terminal attach <terminal_id>`。
 * 用 terminal attach 而不是 agent attach：前者对 agent 和普通 shell pane 都适用。
 *
 * 不使用 --takeover：电脑上的 herdr TUI 与网页可以同时连接（已验证）。
 * attach 期间 pane 尺寸跟随网页终端，断开后 herdr 自动恢复为 TUI 的尺寸。
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

  constructor(config: Config, service: ProjdeckService) {
    this.config = config;
    this.service = service;
  }

  async open(ws: WebSocket, paneId: string, cols: number, rows: number): Promise<void> {
    const control = (msg: ServerFrame) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    if (this.active.size >= MAX_TERMINALS) {
      control({ t: "error", message: "打开的终端太多了，请先关闭一些页面" });
      return ws.close();
    }
    let terminalId: string;
    try {
      terminalId = await this.service.terminalIdOf(paneId);
    } catch (err) {
      control({ t: "error", message: (err as Error).message });
      return ws.close();
    }
    if (ws.readyState !== ws.OPEN) return;

    // 去掉 HERDR_* 变量：agentd 自己可能运行在某个 herdr pane 里，避免被当成嵌套客户端或连错 socket
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("HERDR_") && k !== "TERM_PROGRAM") env[k] = v;
    }
    env.HERDR_SOCKET_PATH = this.config.herdrSocket;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";

    const term = pty.spawn(this.config.herdrBin, ["terminal", "attach", terminalId], {
      name: "xterm-256color",
      cols: clamp(cols, 20, 500),
      rows: clamp(rows, 5, 200),
      cwd: process.env.HOME,
      env,
      encoding: null,
    });
    this.active.add(term);

    // attach 失败时 herdr 会输出一行 JSON 错误然后退出，转成可读的提示
    let started = false;
    term.onData((data) => {
      const buf = data as unknown as Buffer;
      if (!started) {
        started = true;
        const head = buf.subarray(0, 300).toString("utf8");
        if (head.startsWith('{"error"')) {
          const message = /"message":"([^"]*)"/.exec(head)?.[1] ?? head;
          control({ t: "error", message: `无法连接终端：${message}` });
          return;
        }
      }
      if (ws.readyState !== ws.OPEN) return;
      ws.send(buf, { binary: true });
      if (ws.bufferedAmount > HIGH_WATER) {
        term.pause();
        const resume = setInterval(() => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount < HIGH_WATER / 4) {
            clearInterval(resume);
            term.resume();
          }
        }, 50);
      }
    });

    term.onExit(() => {
      this.active.delete(term);
      control({ t: "exit" });
      ws.close();
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw)) as ClientFrame;
      } catch {
        return;
      }
      if (frame.t === "i" && typeof frame.d === "string") term.write(frame.d.replaceAll("\x02", "\x02\x02"));
      if (frame.t === "r") term.resize(clamp(frame.c, 20, 500), clamp(frame.r, 5, 200));
    });

    // 关闭网页即断开 attach，pane 尺寸随之恢复
    ws.on("close", () => {
      if (this.active.delete(term)) term.kill();
    });
  }

  closeAll(): void {
    for (const term of this.active) term.kill();
    this.active.clear();
  }
}
