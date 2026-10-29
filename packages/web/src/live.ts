import { useEffect, useState, useSyncExternalStore } from "react";
import type { ClientMessage, Overview, ServerMessage, TranscriptEntry } from "@projdeck/shared";
import { refreshTheme } from "@/lib/terminalTheme";

type Listener = () => void;

interface PaneState {
  transcript: TranscriptEntry[];
  conversationId: string | null;
}

/**
 * 单例 WebSocket 连接：接收总览推送，以及正在查看的会话的对话记录增量。
 * 断线后指数退避重连，重连后自动重新 watch。
 */
class LiveConnection {
  overview: Overview | null = null;
  connected = false;
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private panes = new Map<string, PaneState>();
  private watching = new Map<string, number>();
  private backoff = 500;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
    // 手机切回前台时立即重连，不等退避计时
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.connected) {
        this.backoff = 500;
        this.ws?.close();
        this.connect();
      }
    });
  }

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 500;
      for (const paneId of this.watching.keys()) this.send({ op: "watch", paneId });
      this.notify();
    };
    ws.onmessage = (ev) => this.handle(JSON.parse(String(ev.data)) as ServerMessage);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.notify();
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    };
  }

  private handle(msg: ServerMessage): void {
    if (msg.type === "theme") return refreshTheme(true);
    if (msg.type === "overview") this.overview = msg.overview;
    if (msg.type === "transcript") {
      const p = this.pane(msg.paneId);
      const { page } = msg;
      if (page.reset) p.transcript = page.entries;
      else {
        // 新客户端加入时服务端可能重复发送同一段，按 id 去重
        const seen = new Set(p.transcript.map((e) => e.id));
        p.transcript = [...p.transcript, ...page.entries.filter((e) => !seen.has(e.id))];
      }
      p.conversationId = page.conversationId;
    }
    this.notify();
  }

  private pane(paneId: string): PaneState {
    let p = this.panes.get(paneId);
    if (!p) this.panes.set(paneId, (p = { transcript: [], conversationId: null }));
    return p;
  }

  getPane(paneId: string): PaneState | undefined {
    return this.panes.get(paneId);
  }

  watch(paneId: string): () => void {
    this.watching.set(paneId, (this.watching.get(paneId) ?? 0) + 1);
    if (this.watching.get(paneId) === 1) this.send({ op: "watch", paneId });
    return () => {
      const n = (this.watching.get(paneId) ?? 1) - 1;
      if (n > 0) return void this.watching.set(paneId, n);
      this.watching.delete(paneId);
      this.panes.delete(paneId);
      this.send({ op: "unwatch", paneId });
    };
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // useSyncExternalStore 需要稳定的快照引用，每次变化递增版本号
  version = 0;
  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

export const live = new LiveConnection();

export function useLive(): LiveConnection {
  useSyncExternalStore(live.subscribe, () => live.version);
  return live;
}

export function usePane(paneId: string): PaneState | undefined {
  const l = useLive();
  useEffect(() => l.watch(paneId), [l, paneId]);
  return l.getPane(paneId);
}

/** 窄屏（手机）判断，用于切换单栏 / 双栏布局。 */
export function useWide(): boolean {
  const query = "(min-width: 900px)";
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}
