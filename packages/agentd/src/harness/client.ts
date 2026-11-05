import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { configDir } from "../config.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { WebSocket as Socket, RawData } from "ws";
import type { TranscriptEntry, TranscriptPage } from "@projdeck/shared";
import type { HarnessBackend, HarnessSession } from "./backend.ts";
export type { HarnessSession } from "./backend.ts";

// Cookie headers require ws rather than Node's browser-shaped WebSocket. Reuse
// the existing @fastify/websocket dependency, without depending on the dsh SDK.
const require = createRequire(import.meta.url);
const { WebSocket } = createRequire(require.resolve("@fastify/websocket"))("ws") as typeof import("ws");
const TIMEOUT = 5_000;
const MAX_BODY = 32 * 1024 * 1024;
const fail = (message = "Harness 协议响应无效") => new Error(message);
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw fail();
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw fail();
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw fail();
  return value as number;
}
function parse(text: string): ObjectValue {
  try { return object(JSON.parse(text)); } catch { throw fail(); }
}

type Connection = { base: string; token: string };
/** Validate before sending any credential; pin localhost DNS to loopback too. */
function localUrl(input: string): URL {
  try {
    // Check the written authority as well as URL's normalized hostname (reject
    // credentials, numeric aliases, backslashes and whitespace normalization).
    if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input)
      || /[\\\s\u0000-\u001f]/.test(input)) throw fail();
    const url = new URL(input);
    if (url.protocol !== "http:" || url.username || url.password
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw fail();
    return url;
  } catch { throw fail("Harness 仅允许无用户名和密码的本机 loopback HTTP 地址"); }
}
function connection(input: string, savedToken?: unknown): Connection {
  const url = localUrl(input);
  const tokens = url.searchParams.getAll("token");
  const token = savedToken === undefined
    ? (tokens.length === 1 ? tokens[0] : undefined) : savedToken;
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)
    || (savedToken !== undefined && tokens.length)) throw fail("Harness 连接配置缺少有效 token");
  url.search = "";
  url.hash = "";
  if (url.pathname.endsWith("/connect")) url.pathname = url.pathname.slice(0, -7);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return { base: url.href, token };
}
function endpoint(config: Connection, path: string): URL {
  return new URL(path, config.base);
}

type WireEvent = { type: string; seq: number; time: number; data: ObjectValue; surfaceOp?: unknown };
function records(value: unknown): WireEvent[] {
  return array(value).map((raw) => {
    const record = object(raw);
    if (record.type !== "event") throw fail();
    const e = object(record.event);
    return { type: string(e.type), seq: integer(e.seq), time: integer(e.time),
      data: object(e.data), surfaceOp: e.surfaceOp };
  });
}
type Attempt = {
  id: string; turn: number; step: number; after: number; next: number;
  blocks: Map<number, string>;
};
type Waiter = { resolve: () => void; reject: (error: Error) => void };
type FollowState = {
  id: string; readers: number; listeners: Map<(page: TranscriptPage) => void, number>;
  task?: Promise<void>; controller?: AbortController; ready: boolean; waiters: Set<Waiter>;
  events: WireEvent[]; through: number; attempt?: Attempt; revision: number;
  entries: TranscriptEntry[]; cursor: number; versions: Map<number, TranscriptEntry[]>;
};

/** A bounded inbox preserves frames arriving while backwards history is loading. */
class Inbox {
  queue: ObjectValue[] = [];
  wake?: () => void;
  error?: Error;
  ended = false;
  push(value: ObjectValue): void {
    if (this.queue.length >= 10_000) { this.stop(fail("Harness 实时流积压，需重新同步")); return; }
    this.queue.push(value);
    this.wake?.();
  }
  stop(error?: Error): void { this.error = error; this.ended = true; this.wake?.(); }
  async next(): Promise<ObjectValue | undefined> {
    while (!this.queue.length && !this.ended) await new Promise<void>((resolve) => { this.wake = resolve; });
    this.wake = undefined;
    if (this.error) throw this.error;
    return this.queue.shift();
  }
}

/** Official dsh web protocol, verified against 0.2.1-rc.2. No profile or session-file access. */
export class HarnessClient implements HarnessBackend {
  #file: string;
  #config?: Connection;
  #error?: string;
  #closed = false;
  #lifetime = new AbortController();
  #socket?: Socket;
  #connecting?: Promise<void>;
  #streams = new Map<string, Inbox>();
  #sessions = new Map<string, FollowState>();
  #heartbeat?: ReturnType<typeof setInterval>;
  #cursor = 0;
  #listing?: Promise<HarnessSession[]>;
  #listCache?: { at: number; value: HarnessSession[] };
  #listFailedAt = 0;

  constructor(file?: string) {
    this.#file = file ?? join(configDir, "harness.json");
    try {
      const saved = object(JSON.parse(readFileSync(this.#file, "utf8")));
      const input = saved.url ?? saved.base;
      this.#config = connection(string(input), saved.token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#error = "Harness 配置无效或无法读取";
    }
  }

  status(): { configured: boolean; online: boolean; error?: string } {
    return { configured: !!this.#config, online: this.#socket?.readyState === WebSocket.OPEN,
      ...(this.#error ? { error: this.#error } : {}) };
  }

  webTarget(): { base: string; token: string } {
    if (!this.#config) throw fail("Harness 尚未配置，请先在设置里接入");
    return { ...this.#config };
  }

  async configure(connectionUrl: string): Promise<void> {
    const config = connection(connectionUrl);
    const previous = this.#config;
    this.#shutdown();
    this.#closed = false;
    this.#lifetime = new AbortController();
    this.#config = config;
    this.#error = undefined;
    const lifetime = this.#lifetime;
    try {
      await this.#ensureConnection();
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
      const temporary = `${this.#file}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(config) + "\n");
          await file.sync();
        } finally { await file.close(); }
        lifetime.signal.throwIfAborted();
        await rename(temporary, this.#file);
      } finally { await rm(temporary, { force: true }); }
    } catch {
      if (this.#lifetime === lifetime) {
        const message = this.#error ?? "Harness 连接或配置保存失败";
        this.#config = previous;
        this.#disconnect(fail(message));
        this.#error = message;
      }
      throw fail(this.#error ?? "Harness 配置操作已取消");
    }
  }

  close(): void { this.#shutdown(); this.#closed = true; }

  async list(): Promise<HarnessSession[]> {
    if (this.#closed || !this.#config) throw fail(this.#closed ? "Harness 客户端已关闭" : "Harness 尚未配置");
    if (this.#listCache && Date.now() - this.#listCache.at < 1_000) return structuredClone(this.#listCache.value);
    if (Date.now() - this.#listFailedAt < 1_000) throw fail("Harness 会话列表暂不可用，请稍后重试");
    if (!this.#listing) {
      const lifetime = this.#lifetime;
      const task = this.#list().then((value) => {
        if (this.#lifetime === lifetime && !lifetime.signal.aborted) this.#listCache = { at: Date.now(), value };
        return value;
      }, (error: unknown) => {
        if (this.#lifetime === lifetime) this.#listFailedAt = Date.now();
        throw error;
      }).finally(() => { if (this.#listing === task) this.#listing = undefined; });
      this.#listing = task;
    }
    return structuredClone(await this.#listing);
  }

  async #list(): Promise<HarnessSession[]> {
    const result = object(await this.#rpc("list", {}, undefined, "_request"));
    return array(result.items).map((raw) => {
      const row = object(raw);
      const hints = row.projections === undefined ? {} : object(object(row.projections).values);
      const questions = hints.userQuestions === undefined ? undefined : object(hints.userQuestions);
      const blocked = !!questions && array(questions.active).some((q) => object(q).state === "open");
      return { id: string(row.sessionId), title: typeof hints.title === "string" ? hints.title : "",
        cwd: typeof hints.workingDirectory === "string" ? hints.workingDirectory
          : typeof row.cwd === "string" ? row.cwd : "",
        status: blocked ? "blocked" : row.running === true ? "working"
          : row.agentAvailable === true ? "idle" : "unknown",
        activeAt: typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : null };
    });
  }

  /**
   * 创建会话时先登记/复用对应目录的 Harness 工作区，再让会话加入它。
   * 只传 cwd 的原版客户端会让用户再选一次工作区；加入工作区后原版侧也能直接继续。
   */
  async create(cwd: string | null): Promise<string> {
    return this.#createIn(await this.#workspaceFor(cwd ?? homedir()));
  }

  /** 未归属会话：使用 Harness 的默认工作区，没有时才退回主目录。 */
  async createDefault(): Promise<string> {
    const workspaceId = await this.#defaultWorkspace();
    return this.#createIn(workspaceId);
  }

  async #createIn(workspaceId: string | undefined): Promise<string> {
    const value = object(await this.#rpc("create", workspaceId ? { workspaceId } : { cwd: homedir() }));
    return string(value.sessionId);
  }

  #workspaces = new Map<string, string>();
  #default?: string;

  async #workspaceFor(path: string): Promise<string> {
    const cached = this.#workspaces.get(path);
    if (cached) return cached;
    const value = object(await this.#rpc("create", { path }, undefined, "request", "workspace"));
    const id = string(object(value.workspace).workspaceId);
    this.#workspaces.set(path, id);
    return id;
  }

  async #defaultWorkspace(): Promise<string | undefined> {
    if (this.#default) return this.#default;
    const value = await this.#rpc("initializeDefault", undefined, undefined, "request", "workspace");
    if (value === undefined || value === null) return undefined;
    this.#default = string(object(object(value).workspace).workspaceId);
    return this.#default;
  }
  async prompt(id: string, text: string, files?: string[]): Promise<void> {
    if (files?.length) throw fail("Harness 客户端暂不支持附件；请移除附件后重试");
    if (!text.trim()) throw fail("Harness 提示文本不能为空");
    const receipt = object(await this.#rpc("prompt", { sessionId: id, requestId: randomUUID(),
      mode: "queue", content: [{ type: "text", text }] }));
    if (receipt.accepted !== true) throw fail("Harness 未确认接受提示；请勿自动重发");
  }
  async cancel(id: string): Promise<void> {
    if (object(await this.#rpc("cancel", { sessionId: id })).accepted !== true) throw fail("Harness 未确认取消请求");
  }
  async rename(id: string, title: string): Promise<void> {
    await this.#rpc("rename", { sessionId: id, title });
  }

  /** Numeric cursors are opaque client revisions, not dsh event/byte offsets. */
  async transcript(id: string, cursor: number): Promise<TranscriptPage> {
    const state = this.#state(id);
    state.readers++;
    this.#follow(state);
    try {
      await this.#ready(state);
      return this.#page(state, cursor);
    } finally { state.readers--; this.#release(state); }
  }

  watch(id: string, onPage: (page: TranscriptPage) => void): () => void {
    const state = this.#state(id);
    // Each subscription has its own cursor, even when callbacks are reused.
    const listener = (page: TranscriptPage) => onPage(page);
    state.listeners.set(listener, 0);
    this.#follow(state);
    if (state.ready) this.#notify(state);
    return () => { state.listeners.delete(listener); this.#release(state); };
  }

  async #http(url: URL, signal: AbortSignal, cookie?: string, body?: string): Promise<{
    status: number; headers: IncomingHttpHeaders; body: string;
  }> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => req.destroy(fail("Harness HTTP 请求超时")), TIMEOUT);
      const req = request(url, {
        method: body === undefined ? "GET" : "POST", signal,
        // Never consult DNS for localhost, and never follow an HTTP redirect.
        family: url.hostname === "[::1]" ? 6 : 4,
        lookup: (_host, _options, callback) => callback(null, "127.0.0.1", 4),
        headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : {
          "content-type": "application/json", "content-length": Buffer.byteLength(body).toString(),
        }) },
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_BODY) req.destroy(fail("Harness HTTP 响应过大"));
          else chunks.push(chunk);
        });
        response.on("error", () => { clearTimeout(timer); reject(fail("Harness HTTP 响应中断")); });
        response.on("end", () => {
          clearTimeout(timer);
          resolve({ status: response.statusCode ?? 0, headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      req.on("error", () => { clearTimeout(timer); reject(fail(signal.aborted ? "Harness 请求已取消" : "Harness HTTP 连接失败或超时")); });
      req.end(body);
    });
  }

  #ensureConnection(): Promise<void> {
    if (this.#closed) return Promise.reject(fail("Harness 客户端已关闭"));
    if (!this.#config) return Promise.reject(fail("Harness 尚未配置"));
    if (this.#socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.#connecting) return this.#connecting;
    const config = this.#config;
    const lifetime = this.#lifetime;
    const task = this.#connect(config, lifetime.signal).catch((error: unknown) => {
      if (this.#lifetime === lifetime && !lifetime.signal.aborted) this.#error = error instanceof Error ? error.message : "Harness 连接失败";
      throw error;
    }).finally(() => { if (this.#connecting === task) this.#connecting = undefined; });
    this.#connecting = task;
    return task;
  }

  async #connect(config: Connection, signal: AbortSignal): Promise<void> {
    const url = endpoint(config, "connect");
    url.searchParams.set("token", config.token);
    url.searchParams.set("interactions", "none");
    const response = await this.#http(url, signal);
    if (response.status === 401) throw fail("Harness 认证失败（HTTP 401），请重新配置启动链接");
    const mux = endpoint(config, "api/remote.mux");
    let location: URL;
    try { location = new URL(response.headers.location ?? "", url); } catch { throw fail(); }
    if (response.status !== 302 || location.href !== mux.href) throw fail("Harness 握手被拒绝或返回了非预期重定向");
    const cookies = response.headers["set-cookie"];
    if (!cookies?.length || cookies.length !== 1) throw fail("Harness 握手未返回 API peer Cookie");
    const cookie = cookies[0]!.split(";", 1)[0]!;
    if (!/^[!#$%&'*+.^_`|~\w-]+=[^\s;,]+$/.test(cookie)) throw fail();
    signal.throwIfAborted();
    mux.protocol = "ws:";
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(mux, { headers: { cookie }, followRedirects: false,
        handshakeTimeout: TIMEOUT, maxPayload: MAX_BODY, family: mux.hostname === "[::1]" ? 6 : 4,
        lookup: (_host, _options, callback) => callback(null, "127.0.0.1", 4) });
      let opened = false;
      const abort = () => ws.terminate();
      signal.addEventListener("abort", abort, { once: true });
      ws.on("unexpected-response", (_req, res) => {
        res.destroy();
        reject(fail(res.statusCode === 401 ? "Harness API peer 认证失败（HTTP 401）" : "Harness WebSocket 握手被拒绝"));
        ws.terminate();
      });
      ws.on("open", () => {
        if (signal.aborted) { ws.terminate(); reject(fail("Harness 连接已取消")); return; }
        opened = true;
        this.#socket = ws;
        // Cookie belongs to this API peer generation only; never persisted or exposed.
        this.#cookies.set(ws, cookie);
        this.#error = undefined;
        let pong = true;
        ws.on("pong", () => { pong = true; });
        this.#heartbeat = setInterval(() => {
          if (!pong) this.#disconnect(fail("Harness WebSocket 心跳超时"));
          else { pong = false; ws.ping(); }
        }, 20_000);
        this.#heartbeat.unref();
        resolve();
      });
      ws.on("message", (data: RawData, binary: boolean) => {
        if (this.#socket !== ws) return;
        try {
          if (binary) throw fail();
          const frame = parse(data.toString());
          const inbox = this.#streams.get(string(frame.streamId));
          if (!["item", "end", "error"].includes(string(frame.type))) throw fail();
          inbox?.push(frame);
        } catch { this.#disconnect(fail("Harness 实时流协议无效")); }
      });
      ws.on("error", () => {
        if (!opened) reject(fail("Harness WebSocket 连接失败或超时"));
        if (this.#socket === ws) this.#disconnect(fail("Harness WebSocket 连接失败"));
      });
      ws.on("close", () => {
        signal.removeEventListener("abort", abort);
        if (!opened) reject(fail("Harness WebSocket 握手中断"));
        if (this.#socket === ws) this.#disconnect(fail("Harness WebSocket 已断开"));
      });
    });
  }
  #cookies = new WeakMap<Socket, string>();

  async #rpc(method: string, requestValue: unknown, signal?: AbortSignal, parameter = "request", namespace = "session"): Promise<unknown> {
    const lifetime = this.#lifetime;
    await this.#ensureConnection();
    lifetime.signal.throwIfAborted();
    const ws = this.#socket!;
    const config = this.#config!;
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const rpcId = randomUUID();
    let response;
    try {
      response = await this.#http(endpoint(config, `api/${namespace}/${method}`), combined, this.#cookies.get(ws),
        JSON.stringify({ type: "client-request", rpcId, method: `${namespace}/${method}`,
          payload: { args: requestValue === undefined ? {} : { [parameter]: requestValue } } }));
    } catch (error) {
      if (!combined.aborted && this.#socket === ws) this.#disconnect(fail("Harness HTTP 连接失败或超时"));
      throw error;
    }
    if (response.status !== 200) {
      const error = fail(response.status === 401 ? "Harness API peer 认证失败（HTTP 401），未重发请求"
        : `Harness RPC 被拒绝（HTTP ${response.status}），未重发请求`);
      if (this.#socket === ws) this.#disconnect(error);
      throw error;
    }
    const envelope = parse(response.body);
    if (envelope.type !== "server-response" || envelope.rpcId !== rpcId) throw fail();
    const result = object(envelope.result);
    if (result.ok === true && namespace === "session" && method !== "list" && method !== "page") this.#listCache = undefined;
    if (result.ok === false) throw fail("Harness RPC 业务失败（请求未被确认为成功）");
    if (result.ok !== true) throw fail();
    return result.value;
  }

  async *#stream(state: FollowState, signal: AbortSignal): AsyncGenerator<ObjectValue> {
    await this.#ensureConnection();
    signal.throwIfAborted();
    const ws = this.#socket!;
    const streamId = randomUUID();
    const inbox = new Inbox();
    const abort = () => inbox.stop(fail("Harness 订阅已取消"));
    signal.addEventListener("abort", abort, { once: true });
    this.#streams.set(streamId, inbox);
    let terminal = false;
    const opening = setTimeout(() => inbox.stop(fail("Harness follow 初始快照超时")), TIMEOUT);
    try {
      ws.send(JSON.stringify({ type: "open", streamId, endpoint: "session/follow", payload: { args: { request: {
        address: { kind: "session", sessionId: state.id }, assistantStream: true, maxMessages: 100,
      } } } }));
      while (true) {
        const frame = await inbox.next();
        signal.throwIfAborted();
        if (!frame) throw fail("Harness 实时流已中断");
        clearTimeout(opening);
        if (frame.type !== "item") {
          terminal = true;
          throw fail(frame.type === "error" ? "Harness follow 请求失败" : "Harness follow 已结束");
        }
        yield object(frame.value);
      }
    } finally {
      clearTimeout(opening);
      signal.removeEventListener("abort", abort);
      this.#streams.delete(streamId);
      if (!terminal && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "cancel", streamId }));
    }
  }

  #state(id: string): FollowState {
    if (this.#closed) throw fail("Harness 客户端已关闭");
    if (!this.#config) throw fail("Harness 尚未配置");
    if (!id) throw fail("Harness 会话 id 不能为空");
    let state = this.#sessions.get(id);
    if (!state) {
      state = { id, readers: 0, listeners: new Map(), ready: false, waiters: new Set(), events: [],
        through: -1, revision: 0, entries: [], cursor: 0, versions: new Map() };
      this.#sessions.set(id, state);
    }
    return state;
  }
  #release(state: FollowState): void {
    if (!state.readers && !state.listeners.size) { state.ready = false; state.controller?.abort(); }
  }
  #ready(state: FollowState): Promise<void> {
    if (state.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { state.waiters.delete(waiter); reject(fail("Harness 历史同步超时")); }, 30_000);
      state.waiters.add(waiter);
    });
  }
  #follow(state: FollowState): void {
    if (state.task || this.#closed || this.#sessions.get(state.id) !== state) return;
    const controller = new AbortController();
    state.controller = controller;
    const signal = AbortSignal.any([controller.signal, this.#lifetime.signal]);
    state.task = (async () => {
      let backoff = 500;
      while (!signal.aborted && (state.readers || state.listeners.size)) {
        try {
          for await (const frame of this.#stream(state, signal)) {
            if (frame.type === "snapshot") {
              await this.#snapshot(state, frame, signal);
              signal.throwIfAborted();
              state.ready = true;
              backoff = 500;
              this.#publish(state, true);
              for (const waiter of state.waiters) waiter.resolve();
              state.waiters.clear();
            } else {
              if (!state.ready) throw fail();
              this.#frame(state, frame);
              this.#publish(state);
            }
          }
        } catch (error) {
          state.ready = false;
          if (signal.aborted) break;
          // All errors from this transport are deliberately credential-free.
          const safe = error instanceof Error ? error : fail();
          this.#error = safe.message;
          for (const waiter of state.waiters) waiter.reject(safe);
          state.waiters.clear();
          if (!state.listeners.size) break;
          try { await delay(backoff, undefined, { signal }); } catch { break; }
          backoff = Math.min(backoff * 2, 8_000);
        }
      }
    })().finally(() => {
      state.ready = false;
      state.task = undefined;
      if (!this.#closed && !this.#lifetime.signal.aborted && (state.readers || state.listeners.size)) this.#follow(state);
    });
  }

  async #snapshot(state: FollowState, frame: ObjectValue, signal: AbortSignal): Promise<void> {
    if (object(frame.header).id !== state.id) throw fail();
    const through = integer(frame.cursor, -1);
    let all = records(frame.records);
    let more = frame.hasMore;
    while (more === true) {
      signal.throwIfAborted();
      if (!all.length || all[0]!.seq === 0) throw fail("Harness 历史分页未前进");
      const before = all[0]!.seq;
      const page = object(await this.#rpc("page", { address: { kind: "session", sessionId: state.id },
        throughSeq: through, beforeSeq: before, maxMessages: 100 }, signal));
      const earlier = records(page.records);
      if (!earlier.length || earlier.at(-1)!.seq >= before) throw fail("Harness 历史分页未前进");
      all = [...earlier, ...all];
      more = page.hasMore;
    }
    // Do not publish an incomplete reconnect window, including log-only events.
    if (more !== false || all.length !== through + 1 || all.some((e, i) => e.seq !== i)) throw fail("Harness 历史存在缺口，需重新同步");
    state.events = all;
    state.through = through;
    state.attempt = undefined;
    state.revision = 0;
    if (frame.assistantStream !== undefined) {
      const baseline = object(frame.assistantStream);
      state.revision = integer(baseline.revision);
      if (baseline.activeAttempt !== undefined) {
        const raw = object(baseline.activeAttempt);
        const attempt = this.#attempt(raw);
        let count = 0;
        for (const member of array(raw.stream)) {
          const run = object(member);
          if (run.type === "chunk") { this.#chunk(attempt, object(run.chunk)); count++; }
          else if (["text-chunks", "reasoning-chunks", "tool-call-chunks"].includes(string(run.type))) {
            const values = array(run.type === "tool-call-chunks" ? run.args : run.texts);
            if (!values.length || array(run.dt).length !== values.length - 1) throw fail();
            for (const value of values) {
              if (run.type === "text-chunks") this.#chunk(attempt, { type: "text-delta", index: run.index, text: string(value) });
              count++;
            }
          } else throw fail();
        }
        attempt.next = integer(raw.nextIndex);
        if (count !== attempt.next) throw fail("Harness assistant 基线存在缺口");
        state.attempt = attempt;
      }
    }
  }
  #attempt(raw: ObjectValue): Attempt {
    return { id: string(raw.attemptId), turn: integer(raw.turn), step: integer(raw.step),
      after: integer(raw.startedAfterSeq, -1), next: 0, blocks: new Map() };
  }
  #chunk(attempt: Attempt, chunk: ObjectValue): void {
    if (chunk.type === "text-delta") {
      const index = integer(chunk.index);
      attempt.blocks.set(index, (attempt.blocks.get(index) ?? "") + string(chunk.text));
    } else if (chunk.type === "block-end") {
      const block = object(chunk.block);
      if (block.type === "text") attempt.blocks.set(integer(chunk.index), string(block.text));
    }
  }
  #frame(state: FollowState, frame: ObjectValue): void {
    if (frame.type === "event") {
      const event = records([frame])[0]!;
      if (event.seq !== state.through + 1) throw fail("Harness 会话事件存在缺口，需重新同步");
      state.events.push(event);
      state.through = event.seq;
    } else if (frame.type === "assistant-stream") {
      const raw = object(frame.frame);
      const revision = integer(raw.revision);
      if (raw.type === "start" && revision === 1) state.revision = 0;
      if (revision !== state.revision + 1) throw fail("Harness assistant 修订存在缺口");
      state.revision = revision;
      if (raw.type === "start") state.attempt = this.#attempt(raw);
      else {
        const attempt = state.attempt;
        if (!attempt || raw.attemptId !== attempt.id || raw.index !== attempt.next) throw fail("Harness assistant 流存在缺口");
        if (raw.type === "chunk") { this.#chunk(attempt, object(raw.chunk)); attempt.next++; }
        else if (raw.type === "end") {
          const outcome = object(raw.outcome);
          if (outcome.kind === "committed") {
            const e = state.events[integer(outcome.seq)];
            if (!e || e.type !== outcome.eventType) throw fail("Harness assistant 结算尚未同步");
          } else if (outcome.kind !== "abandoned") throw fail();
          state.attempt = undefined;
        } else throw fail();
      }
    } else throw fail();
  }

  #render(state: FollowState): TranscriptEntry[] {
    const surface: WireEvent[] = [];
    const tools = new Map<string, string>();
    for (const e of state.events) {
      if (e.type === "tool/call") tools.set(string(e.data.callId), string(e.data.name));
      if (!["system/message", "developer/message", "user/message", "assistant/message", "tool/result"].includes(e.type)) continue;
      if (e.surfaceOp === "append") surface.push(e);
      else {
        const op = object(e.surfaceOp);
        const start = surface.findIndex((node) => node.seq === op.startSeq);
        const end = surface.findIndex((node) => node.seq === op.endSeq);
        if (op.op !== "replace" || start < 0 || end < start) throw fail("Harness 会话修订范围无效");
        surface.splice(start, end - start + 1, e);
      }
    }
    const result: TranscriptEntry[] = [];
    const assistantId = (turn: number, step: number) => `${state.id}:assistant:${turn}:${step}`;
    for (const e of surface) {
      if (e.type === "user/message") result.push({ kind: "user", id: `${state.id}:event:${e.seq}`,
        text: contentText(e.data.content), images: [], time: new Date(e.time).toISOString() });
      else if (e.type === "assistant/message") result.push({ kind: "assistant",
        id: assistantId(integer(e.data.turn), integer(e.data.step)), text: contentText(object(e.data.message).content) });
      else if (e.type === "tool/result") {
        const message = object(e.data.message);
        const callId = string(message.toolCallId);
        result.push({ kind: "tool", id: `${state.id}:event:${e.seq}`, name: tools.get(callId) ?? "tool",
          summary: contentText(message.content), time: new Date(e.time).toISOString() });
      }
    }
    const a = state.attempt;
    if (a) {
      const id = assistantId(a.turn, a.step);
      const text = [...a.blocks].sort(([x], [y]) => x - y).map(([, text]) => text).join("");
      if (text && !surface.some((e) => e.type === "assistant/message" && e.seq > a.after
        && e.data.turn === a.turn && e.data.step === a.step)) result.push({ kind: "assistant", id, text });
    }
    return result;
  }
  #publish(state: FollowState, force = false): void {
    const entries = this.#render(state);
    if (JSON.stringify(entries) !== JSON.stringify(state.entries) || !state.cursor) {
      state.entries = entries;
      state.cursor = ++this.#cursor;
      state.versions.set(state.cursor, entries);
      while (state.versions.size > 16) state.versions.delete(state.versions.keys().next().value!);
    }
    this.#notify(state, force);
  }
  #page(state: FollowState, cursor: number): TranscriptPage {
    const previous = state.versions.get(cursor);
    const append = previous && previous.length <= state.entries.length
      && previous.every((entry, i) => JSON.stringify(entry) === JSON.stringify(state.entries[i]));
    return { conversationId: state.id, cursor: state.cursor, reset: !append,
      // Do not let consumers mutate cached revisions.
      entries: structuredClone(append ? state.entries.slice(previous.length) : state.entries) };
  }
  #notify(state: FollowState, force = false): void {
    for (const [listener, cursor] of state.listeners) {
      if (!force && cursor === state.cursor) continue;
      const page = this.#page(state, force ? 0 : cursor);
      state.listeners.set(listener, page.cursor);
      try { listener(page); } catch { /* A consumer cannot break the stream. */ }
    }
  }
  #disconnect(error: Error): void {
    const socket = this.#socket;
    this.#socket = undefined;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#error = error.message;
    for (const inbox of this.#streams.values()) inbox.stop(error);
    socket?.terminate();
  }
  #shutdown(): void {
    this.#closed = true;
    this.#lifetime.abort();
    this.#connecting = undefined;
    this.#listing = undefined;
    this.#listCache = undefined;
    this.#listFailedAt = 0;
    for (const state of this.#sessions.values()) {
      state.controller?.abort();
      for (const waiter of state.waiters) waiter.reject(fail("Harness 客户端已关闭或重新配置"));
      state.waiters.clear();
      state.listeners.clear();
    }
    this.#sessions.clear();
    this.#disconnect(fail("Harness 客户端已关闭"));
  }
}

function contentText(value: unknown): string {
  return array(value).map((part) => {
    const block = object(part);
    if (block.type === "text") return string(block.text);
    // Do not invent browser-readable URLs for authenticated durable attachments.
    if (block.type === "image") return "[图片]";
    if (block.type === "file") return "[附件]";
    return "";
  }).join("");
}
