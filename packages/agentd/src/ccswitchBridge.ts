import { EventEmitter } from "node:events";
import { httpError } from "./service.ts";

/*
 * 把网页上的 CC Switch 操作转给电脑上正在运行的 CC Switch 执行。
 *
 * CC Switch 是 Tauri 应用：界面是 WebKitGTK 里的网页，通过 window.__TAURI_INTERNALS__.invoke(命令, 参数) 调用它的后台。
 * 它在环境变量 WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:<端口> 下启动时，WebKit 会开一个本机的调试端口；
 * 这里通过它在 CC Switch 的页面里执行 invoke，等于在它的界面里操作：行为与它完全一致，它的界面也同步，
 * 不会有两个程序同时改配置的问题。它推送给界面的事件（切换了供应商、用量更新……）也在页面里订阅，
 * 经控制台消息转发回来。
 *
 * 调试协议是 WebKit Inspector Protocol：连上后会收到页面目标（Target.targetCreated），
 * 命令要包在 Target.sendMessageToTarget 里发给它。
 */

const EVENT_MARK = "__projdeck_ccswitch_event__";

interface Pending {
  resolve: (v: InspectorResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

type RemoteObject = { type: string; value?: unknown; objectId?: string; description?: string };
type InspectorResult = { result?: { result: RemoteObject; wasThrown?: boolean }; error?: { message: string } };

export interface CcSwitchEvent {
  event: string;
  payload: unknown;
}

export class CcSwitchBridge extends EventEmitter {
  private readonly addr: string;
  private ws: WebSocket | null = null;
  private target: string | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  /** 已在 CC Switch 页面里订阅的事件（重连后要重新订阅）。 */
  private readonly events = new Set<string>();

  constructor(addr: string) {
    super();
    this.addr = addr;
  }

  get address(): string {
    return this.addr;
  }

  /** 调试端口能不能连上（CC Switch 是否以 projdeck 需要的方式在运行）。 */
  async available(): Promise<boolean> {
    try {
      await this.ensure();
      return true;
    } catch {
      return false;
    }
  }

  private ensure(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.target) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connect(): Promise<void> {
    // 首页列出可调试的页面，找到 CC Switch 的主界面（tauri://localhost）
    let html: string;
    try {
      html = await (await fetch(`http://${this.addr}/`, { signal: AbortSignal.timeout(2_000) })).text();
    } catch {
      throw httpError(503, "连不上 CC Switch：它没有在运行，或者不是经 projdeck 设置过的方式启动的");
    }
    const rows = html.split("<tr").filter((r) => r.includes("tauri://localhost") && r.includes("/socket/"));
    const path = /'(\/socket\/[^']+)'|(\/socket\/[^'"&]+)/.exec(rows[0] ?? "");
    if (!path) throw httpError(503, "CC Switch 的界面没有加载（可能处于轻量模式），请在电脑上打开一次 CC Switch");

    const ws = new WebSocket(`ws://${this.addr}${path[1] ?? path[2]}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(httpError(504, "连接 CC Switch 超时")), 5_000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { method?: string; params?: { targetInfo?: { targetId: string; type: string } } };
        if (m.method === "Target.targetCreated" && m.params?.targetInfo?.type === "page") {
          this.target = m.params.targetInfo.targetId;
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(httpError(503, "连不上 CC Switch 的调试端口"));
      };
    });
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => this.onClose(ws);
    await this.send("Console.enable");
    for (const e of this.events) await this.subscribe(e);
  }

  private onClose(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.target = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(httpError(503, "与 CC Switch 的连接断开了"));
    }
    this.pending.clear();
  }

  private onMessage(data: string): void {
    const m = JSON.parse(data) as { method?: string; params?: { message?: string; targetId?: string; targetInfo?: { type: string } } };
    if (m.method === "Target.dispatchMessageFromTarget" && m.params?.message) {
      const inner = JSON.parse(m.params.message) as { id?: number; method?: string; params?: { message?: { text?: string } } } & InspectorResult;
      if (inner.id !== undefined) {
        const p = this.pending.get(inner.id);
        if (p) {
          this.pending.delete(inner.id);
          clearTimeout(p.timer);
          p.resolve(inner);
        }
      } else if (inner.method === "Console.messageAdded") {
        const text = inner.params?.message?.text ?? "";
        if (text.startsWith(EVENT_MARK)) {
          try {
            this.emit("event", JSON.parse(text.slice(EVENT_MARK.length)) as CcSwitchEvent);
          } catch {
            // 不是完整的 JSON
          }
        }
      }
    } else if (m.method === "Target.targetDestroyed") {
      // 页面重新加载或关闭：下次调用时重新连接
      this.ws?.close();
    }
  }

  private send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<InspectorResult> {
    const ws = this.ws;
    if (!ws || !this.target) return Promise.reject(httpError(503, "没有连上 CC Switch"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(httpError(504, "CC Switch 没有响应"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(
        JSON.stringify({
          id: ++this.nextId,
          method: "Target.sendMessageToTarget",
          params: { targetId: this.target, message: JSON.stringify({ id, method, params }) },
        }),
      );
    });
  }

  /** 在 CC Switch 的页面里执行一个返回 Promise 的表达式，返回它的结果（JSON 值）。 */
  private async evaluate(expression: string, timeoutMs?: number): Promise<unknown> {
    await this.ensure();
    const r = await this.send("Runtime.evaluate", { expression }, timeoutMs);
    if (r.error) throw httpError(500, r.error.message);
    if (r.result?.wasThrown) throw httpError(500, r.result.result.description ?? "执行出错");
    const obj = r.result!.result;
    if (!obj.objectId) return obj.value;
    const awaited = await this.send("Runtime.awaitPromise", { promiseObjectId: obj.objectId, returnByValue: true }, timeoutMs);
    if (awaited.error) throw httpError(500, awaited.error.message);
    const value = awaited.result!.result;
    if (awaited.result!.wasThrown) {
      // CC Switch 的命令出错时返回的是一句说明（字符串）
      const message = typeof value.value === "string" ? value.value : (value.description ?? JSON.stringify(value.value));
      throw httpError(400, message);
    }
    return value.value;
  }

  /** 调用 CC Switch 的一个命令，等同于在它界面里操作。 */
  invoke(cmd: string, args: unknown): Promise<unknown> {
    // 安装技能、测速等可能比较慢
    return this.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`, 120_000);
  }

  /** 转发 CC Switch 的某个事件（网页订阅时调用；重复订阅没有影响）。 */
  async listen(event: string): Promise<void> {
    if (this.events.has(event)) return;
    this.events.add(event);
    try {
      await this.ensure();
      await this.subscribe(event);
    } catch (err) {
      this.events.delete(event);
      throw err;
    }
  }

  private async subscribe(event: string): Promise<void> {
    const mark = JSON.stringify(EVENT_MARK);
    await this.evaluate(`(() => {
      const T = window.__TAURI_INTERNALS__;
      const seen = (window.__projdeckEvents ??= {});
      if (seen[${JSON.stringify(event)}]) return Promise.resolve(true);
      seen[${JSON.stringify(event)}] = true;
      const handler = T.transformCallback((e) => console.log(${mark} + JSON.stringify({ event: e.event, payload: e.payload })));
      return T.invoke("plugin:event|listen", { event: ${JSON.stringify(event)}, target: { kind: "Any" }, handler });
    })()`);
  }
}
