import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import type { HerdrAgent, HerdrEvent, HerdrPane, HerdrWorkspace } from "./types.ts";

export class HerdrError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

/** 换行分隔 JSON 的读取器：把字节流切成一条条 JSON 消息。 */
function lineReader(socket: Socket, onMessage: (msg: unknown) => void): void {
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onMessage(JSON.parse(line));
    }
  });
}

/**
 * herdr socket 适配层。projdeck 对 herdr 的所有调用都经过这里。
 * 每个请求使用一条短连接（Unix socket 建连成本很低，也避免请求之间互相阻塞）；
 * 事件订阅使用一条长连接，断线后自动重连。
 */
export class HerdrClient extends EventEmitter<{ event: [HerdrEvent]; online: [boolean] }> {
  readonly socketPath: string;
  online = false;
  lastError: string | undefined;
  private seq = 0;
  private eventSocket: Socket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  request<T = Record<string, unknown>>(method: string, params: object = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const id = `projdeck:${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HerdrError("timeout", `herdr ${method} 超时`));
      }, timeoutMs);
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      socket.on("error", (err) => {
        this.setOnline(false, err.message);
        finish(() => reject(new HerdrError("unavailable", `无法连接 herdr：${err.message}`)));
      });
      lineReader(socket, (msg) => {
        const m = msg as { id: string; result?: T; error?: { code: string; message: string } };
        if (m.id !== id) return;
        this.setOnline(true);
        if (m.error) finish(() => reject(new HerdrError(m.error!.code, m.error!.message)));
        else finish(() => resolve(m.result as T));
      });
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private setOnline(online: boolean, error?: string): void {
    this.lastError = error;
    if (online === this.online) return;
    this.online = online;
    this.emit("online", online);
  }

  // ---- 查询 ----

  async ping(): Promise<{ version: string; protocol: number }> {
    return this.request("ping");
  }

  async listWorkspaces(): Promise<HerdrWorkspace[]> {
    return (await this.request<{ workspaces: HerdrWorkspace[] }>("workspace.list")).workspaces;
  }

  async listPanes(): Promise<HerdrPane[]> {
    return (await this.request<{ panes: HerdrPane[] }>("pane.list")).panes;
  }

  async listAgents(): Promise<HerdrAgent[]> {
    return (await this.request<{ agents: HerdrAgent[] }>("agent.list")).agents;
  }

  async readPane(paneId: string, lines = 400): Promise<string> {
    const r = await this.request<{ read: { text: string } }>("pane.read", {
      pane_id: paneId,
      source: "recent",
      lines,
      format: "ansi",
      strip_ansi: false,
    });
    return r.read.text;
  }

  /** 把工作区移到 beforeId 之前（null = 移到最后）。 */
  async moveWorkspaces(ids: string[], beforeId: string | null): Promise<void> {
    await this.request("workspace.move_block", { workspace_ids: ids, before_workspace_id: beforeId });
  }

  /** pane 在桌面客户端布局里占的区域（字符格）。 */
  async paneRect(paneId: string): Promise<{ width: number; height: number } | null> {
    const r = await this.request<{ layout: { panes: { pane_id: string; rect: { width: number; height: number } }[] } }>(
      "pane.layout",
      { pane_id: paneId },
    );
    return r.layout.panes.find((p) => p.pane_id === paneId)?.rect ?? null;
  }

  /** 当前屏幕的纯文本（不含 ANSI），用于识别 TUI 状态。 */
  async readVisible(paneId: string): Promise<string> {
    const r = await this.request<{ read: { text: string } }>("pane.read", { pane_id: paneId, source: "visible" });
    return r.read.text;
  }

  // ---- 操作 ----

  async prompt(paneId: string, text: string): Promise<void> {
    await this.request("agent.prompt", { target: paneId, text });
  }

  /** 发送文字和按键（shell pane 用这个提交命令）。 */
  async sendInput(paneId: string, text: string, keys: string[] = []): Promise<void> {
    await this.request("pane.send_input", { pane_id: paneId, text, keys });
  }

  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    await this.request("pane.send_keys", { pane_id: paneId, keys });
  }

  async createWorkspace(cwd: string, label: string): Promise<{ workspaceId: string; paneId: string }> {
    const r = await this.request<{ workspace: HerdrWorkspace; root_pane: HerdrPane }>("workspace.create", {
      cwd,
      label,
      focus: false,
    });
    return { workspaceId: r.workspace.workspace_id, paneId: r.root_pane.pane_id };
  }

  async createTab(workspaceId: string, cwd: string, label?: string): Promise<{ paneId: string }> {
    const r = await this.request<{ root_pane: HerdrPane }>("tab.create", {
      workspace_id: workspaceId,
      cwd,
      label: label ?? null,
      focus: false,
    });
    return { paneId: r.root_pane.pane_id };
  }

  /**
   * 在已有 pane 中启动 agent，实际执行的命令为 `<kind> ...args`。
   * 新建的 tab 里 shell 还没就绪时 herdr 返回 agent_pane_busy，稍等重试。
   */
  async startAgent(paneId: string, kind: string, name: string, args: string[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.request("agent.start", { pane_id: paneId, kind, name, args, timeout_ms: 60_000 }, 70_000);
        return;
      } catch (err) {
        if (!(err instanceof HerdrError) || err.code !== "agent_pane_busy" || attempt >= 20) throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  async closePane(paneId: string): Promise<void> {
    await this.request("pane.close", { pane_id: paneId });
  }

  // ---- 事件 ----

  /** 订阅 herdr 事件，断线指数退避重连。 */
  subscribe(): void {
    this.stopped = false;
    let backoff = 500;
    const connect = () => {
      if (this.stopped) return;
      const socket = createConnection(this.socketPath);
      this.eventSocket = socket;
      socket.on("connect", () => {
        backoff = 500;
        const types = [
          "workspace.created", "workspace.closed", "workspace.renamed", "workspace.updated",
          "tab.created", "tab.closed",
          "pane.created", "pane.closed", "pane.exited", "pane.updated", "pane.agent_detected",
        ];
        socket.write(
          JSON.stringify({
            id: "projdeck:events",
            method: "events.subscribe",
            params: { subscriptions: types.map((type) => ({ type })) },
          }) + "\n",
        );
      });
      lineReader(socket, (msg) => {
        const m = msg as HerdrEvent & { id?: string; result?: unknown; error?: { message: string } };
        if (m.id === "projdeck:events") {
          if (m.error) this.setOnline(true, `事件订阅失败：${m.error.message}`);
          else this.setOnline(true);
          return;
        }
        if (m.event) this.emit("event", m);
      });
      const retry = () => {
        if (this.stopped || this.eventSocket !== socket) return;
        this.eventSocket = undefined;
        this.setOnline(false, "herdr 连接断开");
        this.reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };
      socket.on("error", retry);
      socket.on("close", retry);
    };
    connect();
  }

  /** 不等退避，立即重连（刚启动 herdr 服务端后调用）。 */
  reconnectNow(): void {
    if (this.online || this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const old = this.eventSocket;
    this.eventSocket = undefined; // 先解绑，旧连接关闭时不再触发重连
    old?.destroy();
    this.subscribe();
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.eventSocket?.destroy();
  }
}
