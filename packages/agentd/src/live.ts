import type { ClientMessage, ServerMessage } from "@projdeck/shared";
import type { WebSocket } from "ws";
import type { HerdrClient } from "./herdr/client.ts";
import type { ProjdeckService } from "./service.ts";

const OVERVIEW_POLL_MS = 2_000;
const TRANSCRIPT_POLL_MS = 1_500;

interface Watch {
  clients: Set<WebSocket>;
  cursor: number;
  transcriptTimer?: NodeJS.Timeout;
  /** 有人在看对话视图期间，这个会话的「已完成」算已读。 */
  endView?: () => void;
}

/**
 * WebSocket 推送中心：总览，以及正在查看的会话的对话记录增量。
 * 终端画面不经过这里，由 terminal.ts 的 attach 直连提供。
 * 总览由 herdr 事件触发刷新，另有低频轮询兜底（agent 状态变化没有全局事件）。
 * 对话记录只对「有人正在看」的会话轮询，没人看时不产生任何开销。
 */
export class LiveHub {
  private readonly service: ProjdeckService;
  private readonly clients = new Set<WebSocket>();
  private readonly watches = new Map<string, Watch>();
  private lastOverview = "";
  private overviewTimer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;

  constructor(service: ProjdeckService, herdr: HerdrClient) {
    this.service = service;
    herdr.on("event", () => this.scheduleOverview());
    herdr.on("online", () => this.scheduleOverview());
  }

  add(ws: WebSocket): void {
    this.clients.add(ws);
    if (this.lastOverview) ws.send(this.lastOverview);
    this.scheduleOverview();
    if (!this.overviewTimer) this.overviewTimer = setInterval(() => void this.pushOverview(), OVERVIEW_POLL_MS);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (msg.op === "watch") void this.watch(ws, msg.paneId);
      if (msg.op === "unwatch") this.unwatch(ws, msg.paneId);
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      for (const paneId of this.watches.keys()) this.unwatch(ws, paneId);
      if (this.clients.size === 0) {
        clearInterval(this.overviewTimer);
        this.overviewTimer = undefined;
      }
    });
  }

  /** 向所有页面推送一条消息。 */
  broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of this.clients) ws.send(text);
  }

  /** 状态可能已变化（例如刚执行完操作），尽快推送一次总览。 */
  scheduleOverview(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.pushOverview(), 250);
  }

  private async pushOverview(): Promise<void> {
    if (this.clients.size === 0) return;
    try {
      const overview = await this.service.overview();
      const msg = JSON.stringify({ type: "overview", overview } satisfies ServerMessage);
      if (msg === this.lastOverview) return;
      this.lastOverview = msg;
      for (const ws of this.clients) ws.send(msg);
    } catch {
      // service.overview 已把 herdr 离线写进结果，这里只可能是意外错误；下次轮询再试
    }
  }

  private async watch(ws: WebSocket, paneId: string): Promise<void> {
    let w = this.watches.get(paneId);
    const fresh = !w;
    if (!w) {
      w = { clients: new Set(), cursor: -1 };
      this.watches.set(paneId, w);
      const watch = w;
      this.service.beginView(paneId).then(
        (end) => (this.watches.get(paneId) === watch ? (watch.endView = end) : end()),
        () => {},
      );
    }
    w.clients.add(ws);

    // 新加入的客户端先拿到完整的会话记录
    try {
      const page = await this.service.transcript(paneId, -1);
      if (fresh || w.cursor < 0) w.cursor = page.cursor;
      send(ws, { type: "transcript", paneId, page: { ...page, reset: true } });
    } catch {
      // 会话可能刚被关闭，总览推送会让前端离开这个页面
    }
    // 等待期间可能已 unwatch 又重新 watch（React StrictMode 会这样），只给仍然生效的那次 watch 启动轮询
    if (fresh && this.watches.get(paneId) === w) this.pollTranscript(paneId, w);
  }

  private unwatch(ws: WebSocket, paneId: string): void {
    const w = this.watches.get(paneId);
    if (!w) return;
    w.clients.delete(ws);
    if (w.clients.size === 0) {
      clearTimeout(w.transcriptTimer);
      w.endView?.();
      this.watches.delete(paneId);
    }
  }

  private pollTranscript(paneId: string, w: Watch): void {
    w.transcriptTimer = setTimeout(async () => {
      try {
        const page = await this.service.transcript(paneId, w.cursor);
        // 对话 ID 刚出现时（agent 启动后第一次发消息）cursor 还是 -1，此时整页即为全量
        if (page.entries.length || page.reset || page.cursor !== w.cursor) {
          const reset = page.reset || w.cursor < 0;
          w.cursor = page.cursor;
          if (page.entries.length || reset) {
            for (const ws of w.clients) send(ws, { type: "transcript", paneId, page: { ...page, reset } });
          }
        }
      } catch {
        // 下一轮再试
      }
      if (this.watches.get(paneId) === w) this.pollTranscript(paneId, w);
    }, TRANSCRIPT_POLL_MS);
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
