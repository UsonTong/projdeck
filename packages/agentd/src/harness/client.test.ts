import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { WebSocket as Socket } from "ws";
import type { TranscriptEntry, TranscriptPage } from "@projdeck/shared";
import { HarnessClient } from "./client.ts";

const require = createRequire(import.meta.url);
const { WebSocketServer } = createRequire(require.resolve("@fastify/websocket"))("ws") as typeof import("ws");
const TOKEN = "fake-launch-secret-never-use-real-token";
type Json = Record<string, any>;
type RecordEvent = { type: "event"; event: Json };
function event(seq: number, type: string, data: Json, surfaceOp?: unknown): RecordEvent {
  return { type: "event", event: { seq, type, time: 1_700_000_000_000 + seq, data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }) } };
}
const user = (seq: number, text: string) => event(seq, "user/message", { content: [{ type: "text", text }] }, "append");
const assistant = (seq: number, text: string, turn = 0, step = 0) => event(seq, "assistant/message", {
  turn, step, message: { content: [{ type: "text", text }] }, stream: [],
}, "append");
const snapshot = (records: RecordEvent[] = [], extra: Json = {}) => ({ type: "snapshot", header: { id: "s1" },
  cursor: records.at(-1)?.event.seq ?? -1, records, hasMore: false,
  projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 }, ...extra });

async function body(req: IncomingMessage): Promise<Json> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(parts).toString());
}
async function until(predicate: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail("等待 fake host 条件超时");
    await delay(5);
  }
}

async function fixture(t: TestContext, host = "127.0.0.1") {
  const directory = await mkdtemp(join(tmpdir(), "projdeck-harness-test-"));
  const file = join(directory, "config.json");
  const peers = new Map<string, { connected: boolean }>();
  const socketCookies = new Map<Socket, string>();
  const streams = new Map<string, { ws: Socket; frame: Json }>();
  const requests: { url: string; cookie?: string; message?: Json }[] = [];
  const wsRequests: { url: string; cookie?: string }[] = [];
  let exchanges = 0;
  let initial: Json = snapshot();
  const settings = { connectStatus: 302, redirect: "./api/remote.mux", cookie: true,
    rpcStatus: 200, rpcFailure: false, wrongId: false, hang: false, wsStatus: 101 };
  const replies: Record<string, unknown> = {
    list: { items: [
      { sessionId: "s1", updatedAt: 1700000000000, running: true, agentAvailable: true, cwd: "/work",
        projections: { values: { title: "标题", workingDirectory: "/current" } } },
      { sessionId: "cold", updatedAt: 0, running: false, agentAvailable: false },
      { sessionId: "ask", updatedAt: 1, running: true, agentAvailable: true,
        projections: { values: { userQuestions: { active: [{ state: "open" }] } } } },
    ] }, create: { sessionId: "new-session" }, prompt: { accepted: true }, cancel: { accepted: true },
    rename: { title: "新标题", seq: 5 }, page: { records: [], hasMore: false },
    "workspace/create": { workspace: { workspaceId: "ws-work" }, created: true },
    "workspace/insertSessionBefore": { workspace: { workspaceId: "ws-work" } },
  };
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fake.invalid");
    const log = { url: req.url!, cookie: req.headers.cookie, message: undefined as Json | undefined };
    requests.push(log);
    if (url.pathname === "/connect") {
      exchanges++;
      if (url.searchParams.get("token") !== TOKEN || settings.connectStatus !== 302) {
        res.writeHead(settings.connectStatus === 302 ? 401 : settings.connectStatus).end(); return;
      }
      assert.equal(url.searchParams.get("interactions"), "none");
      assert.equal(req.headers.cookie, undefined);
      const cookie = `dsh-peer=fake-${exchanges}`;
      peers.set(cookie, { connected: false });
      res.writeHead(302, { location: settings.redirect,
        ...(settings.cookie ? { "set-cookie": `${cookie}; Path=/; HttpOnly; SameSite=Strict` } : {}) }).end();
      return;
    }
    const route = /^\/api\/(session|workspace)\/(.+)$/.exec(url.pathname);
    if (!route) { res.writeHead(404).end(); return; }
    if (!peers.get(req.headers.cookie ?? "")?.connected) { res.writeHead(401).end(); return; }
    const message = await body(req);
    log.message = message;
    const [, namespace, method] = route as unknown as [string, string, string];
    assert.equal(message.type, "client-request");
    assert.equal(message.method, `${namespace}/${method}`);
    assert.equal(typeof message.rpcId, "string");
    assert.deepEqual(Object.keys(message.payload), ["args"]);
    assert.deepEqual(Object.keys(message.payload.args), [method === "list" ? "_request" : "request"]);
    if (settings.hang) return;
    if (settings.rpcStatus !== 200) { res.writeHead(settings.rpcStatus, { location: "http://example.invalid/" }).end(); return; }
    const value = replies[`${namespace}/${method}`] ?? replies[method];
    assert.notEqual(value, undefined, `意外的 RPC ${method}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      type: "server-response", rpcId: settings.wrongId ? "wrong" : message.rpcId,
      result: settings.rpcFailure ? { ok: false, error: { code: "fake/error", message: TOKEN, details: {} } }
        : { ok: true, value },
    }));
  });
  server.on("upgrade", (req, socket, head) => {
    wsRequests.push({ url: req.url!, cookie: req.headers.cookie });
    const peer = peers.get(req.headers.cookie ?? "");
    if (req.url !== "/api/remote.mux" || !peer || peer.connected || settings.wsStatus !== 101) {
      socket.end(`HTTP/1.1 ${settings.wsStatus === 101 ? 401 : settings.wsStatus} Unauthorized\r\nConnection: close\r\n\r\n`);
      return;
    }
    peer.connected = true;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const cookie = req.headers.cookie!;
      socketCookies.set(ws, cookie);
      ws.on("close", () => {
        // An API peer is deleted on socket termination, exactly as dsh does.
        peers.delete(cookie);
        socketCookies.delete(ws);
        for (const [id, stream] of streams) if (stream.ws === ws) streams.delete(id);
      });
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === "open") {
          assert.equal(frame.endpoint, "session/follow");
          assert.deepEqual(frame.payload.args.request.address, { kind: "session", sessionId: "s1" });
          assert.equal(frame.payload.args.request.assistantStream, true);
          streams.set(frame.streamId, { ws, frame });
          ws.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: initial }));
        } else if (frame.type === "cancel") streams.delete(frame.streamId);
        else assert.fail(`意外 mux 帧 ${frame.type}`);
      });
    });
  });
  server.listen(0, host);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://${host === "::1" ? "[::1]" : host}:${port}/`;
  const client = new HarnessClient(file);
  t.after(async () => {
    client.close();
    for (const ws of socketCookies.keys()) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return { client, file, directory, base, url: `${base}?token=${TOKEN}`, settings, replies, requests,
    wsRequests, streams, get exchanges() { return exchanges; },
    setSnapshot(value: Json) { initial = value; },
    send(value: Json) {
      for (const [streamId, { ws }] of streams) ws.send(JSON.stringify({ type: "item", streamId, value }));
    },
    drop() { for (const ws of socketCookies.keys()) ws.terminate(); },
  };
}

function collect(client: HarnessClient) {
  const pages: TranscriptPage[] = [];
  let entries: TranscriptEntry[] = [];
  const stop = client.watch("s1", (page) => {
    pages.push(page);
    entries = page.reset ? page.entries : [...entries, ...page.entries];
  });
  return { pages, stop, get entries() { return entries; } };
}

test("未配置不联网，只读取指定配置；状态不泄露凭据", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.client.status(), { configured: false, online: false });
  await assert.rejects(f.client.list(), /尚未配置/);
  await assert.rejects(f.client.create("/work"), /尚未配置/);
  await assert.rejects(f.client.transcript("s1", 0), /尚未配置/);
  assert.equal(f.requests.length, 0);
  await writeFile(f.file, JSON.stringify({ base: f.base, token: TOKEN }), { mode: 0o600 });
  const loaded = new HarnessClient(f.file);
  t.after(() => loaded.close());
  assert.deepEqual(loaded.status(), { configured: true, online: false });
  assert.equal(f.requests.length, 0);
  await loaded.list();
  assert.equal(loaded.status().online, true);
  assert.ok(!JSON.stringify(loaded.status()).includes(TOKEN));
  await writeFile(f.file, JSON.stringify({ url: "http://example.invalid/", token: TOKEN }));
  const invalid = new HarnessClient(f.file);
  t.after(() => invalid.close());
  assert.equal(invalid.status().configured, false);
  assert.ok(invalid.status().error);
});

test("配置、API peer Cookie、官方 RPC 参数和会话映射；list 缓存与并发去重", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.client.configure(f.url), undefined);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { base: f.base, token: TOKEN });
  assert.ok(!(await readFile(f.file, "utf8")).includes("dsh-peer"));
  const lists = await Promise.all([f.client.list(), f.client.list(), f.client.list()]);
  assert.equal(f.exchanges, 1);
  assert.equal(f.requests.filter((r) => r.message?.method === "session/list").length, 1);
  assert.deepEqual(lists[0], [
    { id: "s1", title: "标题", cwd: "/current", status: "working", activeAt: 1700000000000, blank: false },
    { id: "cold", title: "", cwd: "", status: "unknown", activeAt: 0, blank: false },
    { id: "ask", title: "", cwd: "", status: "blocked", activeAt: 1, blank: false },
  ]);
  lists[0]![0]!.title = "不要污染缓存";
  assert.equal((await f.client.list())[0]!.title, "标题");
  assert.equal(await f.client.create("/work"), "new-session");
  await f.client.prompt("s1", "仅 fake host 收到的文本");
  await f.client.cancel("s1");
  await f.client.rename("s1", "新标题");
  const prompt = f.requests.find((r) => r.message?.method === "session/prompt")!.message!.payload.args.request;
  assert.equal(prompt.sessionId, "s1");
  assert.equal(typeof prompt.requestId, "string");
  assert.equal(prompt.mode, "queue");
  assert.deepEqual(prompt.content, [{ type: "text", text: "仅 fake host 收到的文本" }]);
  assert.ok(f.requests.filter((r) => r.message).every((r) => r.cookie === "dsh-peer=fake-1" && !r.url.includes(TOKEN)));
  assert.deepEqual(f.wsRequests, [{ url: "/api/remote.mux", cookie: "dsh-peer=fake-1" }]);
  const count = f.requests.length;
  await assert.rejects(f.client.prompt("s1", "文本", ["/fake/file.png"]), /暂不支持附件/);
  await assert.rejects(f.client.prompt("s1", "  "), /不能为空/);
  assert.equal(f.requests.length, count);
});

test("拒绝外站、userinfo、非 HTTP、非 loopback 和缺失/重复 token", async (t) => {
  const f = await fixture(t);
  for (const url of [
    "http://example.invalid/?token=x", "https://127.0.0.1/?token=x", "ws://localhost/?token=x",
    "http://localhost.evil.invalid/?token=x", "http://127.0.0.2/?token=x", "http://0.0.0.0/?token=x",
    "http://user:pass@127.0.0.1/?token=x", "http://user@localhost/?token=x",
    "http://2130706433/?token=x", "http://127.1/?token=x", " http://localhost/?token=x",
    "http://localhost/", "http://localhost/?token=", "http://localhost/?token=a&token=b",
    "http://localhost\\@example.invalid/?token=x",
  ]) {
    await assert.rejects(f.client.configure(url));
  }
  assert.equal(f.requests.length, 0);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("握手不跟随任何非预期重定向，也不把 Cookie/token 发给目标", async (t) => {
  const f = await fixture(t);
  for (const redirect of ["http://example.invalid/leak", "http://127.0.0.1:1/leak", "//example.invalid/", "/wrong"]) {
    f.settings.redirect = redirect;
    await assert.rejects(f.client.configure(f.url), /重定向/);
    assert.equal(f.client.status().online, false);
  }
  assert.equal(f.requests.length, 4);
  assert.equal(f.wsRequests.length, 0);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  f.settings.redirect = "./api/remote.mux";
  f.settings.cookie = false;
  await assert.rejects(f.client.configure(f.url), /Cookie/);
});

test("localhost 与 IPv6 loopback 地址可用", async (t) => {
  const f = await fixture(t);
  await f.client.configure(f.url.replace("127.0.0.1", "localhost"));
  assert.equal((await f.client.list()).length, 3);
  const ipv6 = await fixture(t, "::1");
  await ipv6.client.configure(ipv6.url);
  assert.equal((await ipv6.client.list()).length, 3);
});

test("401、WS 401、业务失败和 rpcId 错配不能假成功或泄露秘密", async (t) => {
  const f = await fixture(t);
  f.settings.connectStatus = 401;
  await assert.rejects(f.client.configure(f.url), /401/);
  assert.equal(f.client.status().online, false);
  f.settings.connectStatus = 302;
  f.settings.wsStatus = 401;
  await assert.rejects(f.client.configure(f.url), /401/);
  f.settings.wsStatus = 101;
  await f.client.configure(f.url);
  f.settings.rpcFailure = true;
  await assert.rejects(f.client.prompt("s1", "fake"), (error: Error) => !error.message.includes(TOKEN) && /业务失败/.test(error.message));
  f.settings.rpcFailure = false;
  f.settings.wrongId = true;
  await assert.rejects(f.client.create("/fake"), /协议/);
  f.settings.wrongId = false;
  f.settings.rpcStatus = 401;
  await assert.rejects(f.client.prompt("s1", "fake"), /401/);
  assert.equal(f.client.status().online, false);
  assert.equal(f.requests.filter((r) => r.message?.method === "session/prompt").length, 2);
  assert.ok(!JSON.stringify(f.client.status()).includes(TOKEN));
  f.settings.rpcStatus = 200;
  await f.client.cancel("s1");
  assert.equal(f.client.status().online, true);
  assert.equal(f.exchanges, 4);
});

test("RPC 超时有界，不重试可能产生副作用的请求", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  await f.client.configure(f.url);
  f.settings.hang = true;
  const start = Date.now();
  await assert.rejects(f.client.prompt("s1", "fake"), /超时/);
  assert.ok(Date.now() - start < 7_000);
  assert.equal(f.requests.filter((r) => r.message?.method === "session/prompt").length, 1);
  assert.equal(f.client.status().online, false);
});

test("follow 开窗向前补齐历史；transcript 增量、工具结果与 surface replace", async (t) => {
  const f = await fixture(t);
  const first = user(0, "更早的问题");
  const second = assistant(1, "更早的回答");
  const call = event(2, "tool/call", { callId: "call-1", name: "read_file" });
  const result = event(3, "tool/result", { message: { toolCallId: "call-1", content: [{ type: "text", text: "工具结果" }] } }, "append");
  f.setSnapshot(snapshot([call, result], { hasMore: true }));
  f.replies.page = { records: [first, second], hasMore: false };
  await f.client.configure(f.url);
  const watching = collect(f.client);
  await until(() => watching.entries.length === 3);
  const page = await f.client.transcript("s1", 0);
  assert.equal(page.reset, true);
  assert.deepEqual(page.entries.map((e) => e.kind), ["user", "assistant", "tool"]);
  assert.equal((page.entries[2] as { name: string }).name, "read_file");
  assert.deepEqual(f.requests.find((r) => r.message?.method === "session/page")!.message!.payload.args.request,
    { address: { kind: "session", sessionId: "s1" }, throughSeq: 3, beforeSeq: 2, maxMessages: 100 });
  assert.deepEqual((await f.client.transcript("s1", page.cursor)).entries, []);
  f.send(user(4, "新问题"));
  await until(() => watching.entries.length === 4);
  const appended = await f.client.transcript("s1", page.cursor);
  assert.equal(appended.reset, false);
  assert.equal(appended.entries.length, 1);
  const replacement = event(5, "assistant/message", { turn: 0, step: 0,
    message: { content: [{ type: "text", text: "修订回答" }] }, stream: [] }, { op: "replace", startSeq: 1, endSeq: 1 });
  f.send(replacement);
  await until(() => watching.entries.some((e) => e.kind === "assistant" && e.text === "修订回答"));
  const revised = await f.client.transcript("s1", appended.cursor);
  assert.equal(revised.reset, true);
  assert.equal(revised.entries.length, 4);
  assert.equal((revised.entries[1] as { text: string }).text, "修订回答");
  watching.stop();
  await until(() => f.streams.size === 0);
});

test("partial assistant 使用稳定 id，文本修订 reset，全量终稿不重复", async (t) => {
  const f = await fixture(t);
  f.setSnapshot(snapshot([user(0, "问题")]));
  await f.client.configure(f.url);
  const watching = collect(f.client);
  await until(() => watching.entries.length === 1);
  f.send({ type: "assistant-stream", frame: { type: "start", revision: 1, attemptId: "a1", startedAfterSeq: 0, turn: 0, step: 0 } });
  f.send({ type: "assistant-stream", frame: { type: "chunk", revision: 2, attemptId: "a1", index: 0,
    time: 1, chunk: { type: "text-delta", index: 0, text: "你" } } });
  await until(() => watching.entries.length === 2);
  const partial = watching.entries[1]!;
  const previous = watching.pages.at(-1)!;
  f.send({ type: "assistant-stream", frame: { type: "chunk", revision: 3, attemptId: "a1", index: 1,
    time: 2, chunk: { type: "text-delta", index: 0, text: "好" } } });
  await until(() => watching.pages.at(-1)!.cursor !== previous.cursor);
  assert.equal(watching.pages.at(-1)!.reset, true);
  assert.equal(watching.entries[1]!.id, partial.id);
  assert.equal((watching.entries[1] as { text: string }).text, "你好");
  f.send(assistant(1, "你好！"));
  f.send({ type: "assistant-stream", frame: { type: "end", revision: 4, attemptId: "a1", index: 2,
    outcome: { kind: "committed", eventType: "assistant/message", seq: 1 } } });
  await until(() => watching.entries.length === 2 && (watching.entries[1] as { text: string }).text === "你好！");
  assert.equal(watching.entries[1]!.id, partial.id);
  const full = await f.client.transcript("s1", previous.cursor);
  assert.equal(full.reset, true);
  assert.equal(full.entries.length, 2);
  watching.stop();
});

test("WS 断后重新握手、补齐窗口外历史，并恢复 compact assistant 基线", async (t) => {
  const f = await fixture(t);
  const a = user(0, "最早的问题");
  f.setSnapshot(snapshot([a]));
  await f.client.configure(f.url);
  const watching = collect(f.client);
  await until(() => watching.entries.length === 1);
  const b = assistant(1, "断线期间的回答");
  const c = user(2, "断线期间的第二个问题");
  f.setSnapshot(snapshot([c], { hasMore: true, assistantStream: { revision: 9, activeAttempt: {
    attemptId: "after-reconnect", startedAfterSeq: 2, turn: 1, step: 0, nextIndex: 3,
    stream: [
      { type: "text-chunks", index: 0, time0: 1, dt: [1], texts: ["接", "着"] },
      { type: "chunk", time: 3, chunk: { type: "block-end", index: 0, block: { type: "text", text: "接着" } } },
    ],
  } } }));
  f.replies.page = { records: [a, b], hasMore: false };
  f.drop();
  await until(() => f.exchanges >= 2 && watching.entries.length === 4);
  assert.deepEqual(watching.entries.map((e) => "text" in e ? e.text : e.summary), ["最早的问题", "断线期间的回答", "断线期间的第二个问题", "接着"]);
  assert.equal(f.wsRequests.at(-1)!.cookie, "dsh-peer=fake-2");
  const stableId = watching.entries[3]!.id;
  f.send({ type: "assistant-stream", frame: { type: "chunk", revision: 10, attemptId: "after-reconnect", index: 3,
    time: 4, chunk: { type: "text-delta", index: 0, text: "写" } } });
  await until(() => (watching.entries[3] as { text: string }).text === "接着写");
  assert.equal(watching.entries[3]!.id, stableId);
  watching.stop();
  await until(() => f.streams.size === 0);
  const count = watching.pages.length;
  f.send(user(3, "取消后不回调"));
  await delay(20);
  assert.equal(watching.pages.length, count);
});

test("历史缺口不能假成功；流 index 缺口触发重新 follow", async (t) => {
  const f = await fixture(t);
  await f.client.configure(f.url);
  f.setSnapshot(snapshot([user(2, "不完整")], { hasMore: false }));
  await assert.rejects(f.client.transcript("s1", 0), /历史存在缺口/);
  f.setSnapshot(snapshot([user(0, "完整")]));
  const watching = collect(f.client);
  await until(() => watching.entries.length === 1);
  f.send({ type: "assistant-stream", frame: { type: "start", revision: 1, attemptId: "a", startedAfterSeq: 0, turn: 0, step: 0 } });
  const before = watching.pages.length;
  f.send({ type: "assistant-stream", frame: { type: "chunk", revision: 2, attemptId: "a", index: 99,
    time: 1, chunk: { type: "text-delta", index: 0, text: "不能吞掉缺口" } } });
  await until(() => watching.pages.length > before);
  assert.equal(watching.entries.length, 1);
  assert.equal(f.exchanges, 1); // Logical stream loss need not replace a healthy peer.
  watching.stop();
});

test("close 取消订阅与待处理操作；不再自动重连", async (t) => {
  const f = await fixture(t);
  await f.client.configure(f.url);
  const watching = collect(f.client);
  await until(() => watching.pages.length > 0);
  f.settings.hang = true;
  const pending = f.client.create("/fake");
  await until(() => f.requests.some((r) => r.message?.method === "workspace/create"));
  f.client.close();
  await assert.rejects(pending, /取消/);
  assert.equal(f.client.status().online, false);
  await assert.rejects(f.client.list(), /关闭/);
  watching.stop();
  const exchanges = f.exchanges;
  await delay(600);
  assert.equal(f.exchanges, exchanges);
});
