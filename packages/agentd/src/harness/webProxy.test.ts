import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HerdrClient } from "../herdr/client.ts";
import type { ProjdeckService } from "../service.ts";
import type { PushService } from "../push.ts";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = createRequire(require.resolve("@fastify/websocket"))("ws") as typeof import("ws");
const dir = mkdtempSync(join(tmpdir(), "projdeck-harness-proxy-"));
process.env.PROJDECK_CONFIG_DIR = dir;
const { buildServer } = await import("../server.ts");
const { loadConfig } = await import("../config.ts");
const master = "test-projdeck-master-not-real-credentials";
const token = "test-harness-token-not-real-credentials";
writeFileSync(join(dir, "key"), master, { mode: 0o600 });

async function fixture() {
  const seen: { path: string; cookie: string; body: string; origin?: string }[] = [];
  const upstream = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/" && url.searchParams.get("token") === token) {
      res.writeHead(303, { location: "./", "set-cookie": "harness_owner=test-cookie; HttpOnly; Path=/" });
      res.end(); return;
    }
    if (req.headers.cookie !== "harness_owner=test-cookie") { res.writeHead(401).end(); return; }
    let body = "";
    req.on("data", b => body += b.toString());
    req.on("end", () => {
      seen.push({ path: req.url!, cookie: req.headers.cookie!, body, origin: req.headers.origin });
      if (url.pathname === "/redirect") { res.writeHead(302, { location: "/assets/app.js" }).end(); return; }
      if (url.pathname === "/escape") { res.writeHead(302, { location: "http://example.invalid/" }).end(); return; }
      res.setHeader("set-cookie", "should-not-leak=test");
      res.setHeader("content-type", url.pathname === "/" ? "text/html" : "application/json");
      res.end(url.pathname === "/" ? '<html><head><base href="./"></head><body>Original Harness</body></html>' : JSON.stringify({ body, range: req.headers.range }));
    });
  });
  const mux = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (req, socket, head) => {
    if (req.headers.cookie !== "harness_owner=test-cookie") { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
    mux.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data, binary) => ws.send(data, { binary }));
    });
  });
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}/`;
  const service = { harness: { webTarget: () => ({ base, token }), status: () => ({ configured: true, online: true }), close: () => {} } } as unknown as ProjdeckService;
  const app = await buildServer({ ...loadConfig(), accessKeyFile: join(dir, "key") }, service,
    new EventEmitter() as HerdrClient, {} as PushService);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const appAddr = app.server.address();
  assert.ok(appAddr && typeof appAddr === "object");
  return { app, seen, base, url: `http://127.0.0.1:${appAddr.port}`,
    close: async () => { await app.close(); mux.close(); await new Promise<void>(r => upstream.close(() => r())); } };
}

test("原版代理：主密钥保护页面、API 和 WS；HTML/JSON/文件 body 原样通过，凭据仅留后端", async () => {
  const f = await fixture();
  try {
    for (const path of ["/harness", "/harness/", "/harness/assets/app.js", "/harness/api/remote.mux"]) {
      const r = await f.app.inject(path);
      assert.equal(r.statusCode, 401);
    }
    assert.equal((await f.app.inject({ url: "/harness/", headers: { cookie: "projdeck_agent=" + master } })).statusCode, 401);
    const headers = { cookie: "projdeck_key=" + master, host: new URL(f.url).host };
    const html = await f.app.inject({ url: "/harness/", headers });
    assert.equal(html.statusCode, 200);
    assert.match(html.body, /Original Harness/);
    assert.equal(html.headers["set-cookie"], undefined);
    assert.ok(!html.body.includes(token));
    assert.equal(f.seen[0]!.cookie, "harness_owner=test-cookie");
    const combo = "/plugins/??a/client.js,b/client.js&rev=123";
    await f.app.inject({ url: "/harness" + combo, headers });
    assert.equal(f.seen.at(-1)!.path, combo, "原版插件组合资源的查询串不能重编码");
    const payload = '{"message":"原版发送：你好"}';
    const posted = await f.app.inject({ method: "POST", url: "/harness/api/session/prompt", payload,
      headers: { ...headers, "content-type": "application/json", origin: f.url } });
    assert.equal(posted.statusCode, 200);
    assert.equal(JSON.parse(posted.body).body, payload);
    assert.equal(f.seen.at(-1)!.origin, new URL(f.base).origin);
    assert.equal((await f.app.inject({ method: "POST", url: "/harness/api/session/prompt", payload,
      headers: { ...headers, origin: "https://evil.invalid", "content-type": "application/json" } })).statusCode, 403);
    const file = Buffer.from([0, 1, 127, 255]);
    const uploaded = await f.app.inject({ method: "POST", url: "/harness/api/upload", payload: file,
      headers: { ...headers, "content-type": "application/octet-stream" } });
    assert.equal(uploaded.statusCode, 200);
    assert.equal(JSON.parse(uploaded.body).body, file.toString());
    const redirect = await f.app.inject({ url: "/harness/redirect", headers });
    assert.equal(redirect.headers.location, "/harness/assets/app.js");
    assert.equal((await f.app.inject({ url: "/harness/escape", headers })).statusCode, 502);
  } finally { await f.close(); }
});

test("原版代理的 WebSocket 真实双向转发，浏览器主密钥不转交上游", async () => {
  const f = await fixture();
  const ws = new WebSocket(f.url.replace("http:", "ws:") + "/harness/api/remote.mux", {
    headers: { cookie: "projdeck_key=" + master, origin: f.url },
  });
  try {
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const received = new Promise<string>((resolve, reject) => {
      ws.once("message", data => resolve(data.toString())); ws.once("error", reject);
    });
    ws.send('{"type":"open","streamId":"original-ui"}');
    assert.equal(await received, '{"type":"open","streamId":"original-ui"}');
  } finally { ws.terminate(); await f.close(); }
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
