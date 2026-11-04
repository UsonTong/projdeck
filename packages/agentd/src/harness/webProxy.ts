import { request, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RawData, WebSocket as Ws } from "ws";
import type { HarnessBackend } from "./backend.ts";

const require = createRequire(import.meta.url);
const { WebSocket } = createRequire(require.resolve("@fastify/websocket"))("ws") as typeof import("ws");
const PREFIX = "/harness/";
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const error = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
type Target = { base: string; token: string };

/** 原版网页透明代理。主密钥留在 projdeck，Harness token/Cookie 留在此后端，二者互不转发。 */
export class HarnessWebProxy {
  private readonly backend: HarnessBackend;
  private session?: { target: Target; cookie: string };
  private opening?: Promise<string>;
  private readonly sockets = new Set<Ws>();

  constructor(backend: HarnessBackend) { this.backend = backend; }

  private target(): Target {
    const t = this.backend.webTarget?.();
    if (!t) throw error(503, "请先在 projdeck 设置中接入 DeepSeek Harness");
    const url = new URL(t.base);
    // 再次约束代理目标，不能把管理凭据送到外站或变成任意 HTTP 代理。
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
      throw error(400, "Harness 网页仅支持本机服务");
    }
    return t;
  }

  private url(t: Target, raw: string): URL {
    if (!raw.startsWith(PREFIX)) throw error(400, "无效的 Harness 路径");
    const base = new URL(t.base);
    const url = new URL(raw.slice(PREFIX.length), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw error(400, "无效的 Harness 路径");
    // 凭据只由后端掌握；不接受浏览器从查询参数覆盖它。
    // 不重编码 search：原版插件组合资源使用 /plugins/??a.js,b.js&rev=...，重编码会导致 404。
    if (url.searchParams.has("token")) throw error(400, "Harness 凭据只能在设置中配置");
    return url;
  }

  private open(url: URL, method: string, headers: OutgoingHttpHeaders, body?: Readable | Buffer): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request(url, { method, headers, family: url.hostname === "[::1]" ? 6 : 4,
        lookup: (_host, _options, cb) => cb(null, "127.0.0.1", 4),
      }, resolve);
      req.setTimeout(60_000, () => req.destroy());
      req.on("error", () => reject(error(502, "无法连接 Harness 原版网页")));
      if (body && !Buffer.isBuffer(body)) {
        body.on("error", () => req.destroy());
        body.pipe(req);
      } else req.end(body);
    });
  }

  private async cookie(t: Target): Promise<string> {
    if (this.session?.target.base === t.base && this.session.target.token === t.token) return this.session.cookie;
    if (this.opening) return this.opening;
    const task = (async () => {
      const root = new URL(t.base);
      root.searchParams.set("token", t.token);
      const res = await this.open(root, "GET", { "accept-encoding": "identity" });
      res.resume();
      const cookies = res.headers["set-cookie"];
      if (![302, 303].includes(res.statusCode ?? 0) || !cookies?.length) throw error(502, "Harness 网页认证失败，请在设置中重新接入启动链接");
      // 不跟随启动令牌交换的重定向，也不向浏览器暴露上游凭据。
      const redirect = new URL(res.headers.location ?? "", root);
      const base = new URL(t.base);
      if (redirect.origin !== base.origin || !redirect.pathname.startsWith(base.pathname)) throw error(502, "Harness 返回了非预期跳转");
      const cookie = cookies.map((c) => c.split(";", 1)[0]).join("; ");
      this.session = { target: t, cookie };
      return cookie;
    })().finally(() => { if (this.opening === task) this.opening = undefined; });
    this.opening = task;
    return task;
  }

  reset(): void {
    this.session = undefined;
    this.opening = undefined;
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
  }

  async http(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const t = this.target();
    const url = this.url(t, req.raw.url ?? "");
    const headers: OutgoingHttpHeaders = { "accept-encoding": "identity", cookie: await this.cookie(t) };
    // 只转发原版页面需要的少量头，不把 projdeck Cookie、Authorization、代理头发给 Harness。
    for (const name of ["accept", "accept-language", "content-type", "content-length", "range", "if-range", "if-none-match", "if-modified-since", "user-agent"]) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    if (req.headers.origin) headers.origin = new URL(t.base).origin;
    let res = await this.open(url, req.method, headers, req.body as Readable | undefined);
    if (res.statusCode === 401 && (req.method === "GET" || req.method === "HEAD")) {
      res.resume();
      this.session = undefined;
      headers.cookie = await this.cookie(t);
      // 只重试只读请求，避免重复发送消息/上传。
      res = await this.open(url, req.method, headers);
    }
    const out: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(res.headers)) {
      if (!HOP.has(name) && !["set-cookie", "location", "x-frame-options", "content-security-policy"].includes(name)) out[name] = value;
    }
    const csp = res.headers["content-security-policy"];
    if (typeof csp === "string") out["content-security-policy"] = csp.replace(/frame-ancestors\s+[^;]+;?/gi, "") + "; frame-ancestors 'self'";
    out["x-frame-options"] = "SAMEORIGIN";
    out["referrer-policy"] = "no-referrer";
    out["cache-control"] = "private, no-store";
    if (res.headers.location) {
      const location = new URL(res.headers.location, url);
      const base = new URL(t.base);
      if (location.origin !== base.origin || !location.pathname.startsWith(base.pathname)) {
        res.resume();
        throw error(502, "Harness 返回了非预期跳转");
      }
      out.location = PREFIX + location.pathname.slice(base.pathname.length) + location.search + location.hash;
    }
    reply.hijack();
    reply.raw.writeHead(res.statusCode ?? 502, out);
    const abort = () => res.destroy();
    reply.raw.once("close", abort);
    res.once("error", () => reply.raw.destroy());
    res.pipe(reply.raw);
  }

  websocket(client: Ws, req: FastifyRequest): void {
    const queued: { data: RawData; binary: boolean }[] = [];
    let bytes = 0;
    let upstream: Ws | undefined;
    const close = () => {
      if (upstream) { this.sockets.delete(upstream); upstream.terminate(); }
      if (client.readyState < WebSocket.CLOSING) client.close(1011, "Harness connection closed");
    };
    client.on("error", close);
    client.on("close", close);
    client.on("message", (data, binary) => {
      if (upstream?.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount > 32 * 1024 * 1024) return close();
        upstream.send(data, { binary });
      } else {
        bytes += data instanceof ArrayBuffer ? data.byteLength : Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.length;
        if (bytes > 2 * 1024 * 1024) return close();
        queued.push({ data, binary });
      }
    });
    void (async () => {
      const t = this.target();
      const cookie = await this.cookie(t);
      if (client.readyState !== WebSocket.OPEN) return;
      const url = this.url(t, req.raw.url ?? "");
      url.protocol = "ws:";
      upstream = new WebSocket(url, { headers: { cookie, origin: new URL(t.base).origin },
        followRedirects: false, handshakeTimeout: 10_000, maxPayload: 32 * 1024 * 1024, family: url.hostname === "[::1]" ? 6 : 4,
        lookup: (_host, _options, cb) => cb(null, "127.0.0.1", 4),
      });
      this.sockets.add(upstream);
      upstream.on("error", close);
      upstream.on("close", close);
      upstream.on("unexpected-response", (_request, response) => { response.destroy(); close(); });
      upstream.on("open", () => {
        if (client.readyState !== WebSocket.OPEN) return close();
        for (const frame of queued) upstream!.send(frame.data, { binary: frame.binary });
        queued.length = 0;
      });
      upstream.on("message", (data, binary) => {
        if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 32 * 1024 * 1024) return close();
        client.send(data, { binary });
      });
    })().catch(close);
  }
}

/** 全局认证钩子必须先保护 /harness 与 /harness/*（包括 WS），本模块只代理已通过认证的请求。 */
export async function registerHarnessWeb(app: FastifyInstance, backend: HarnessBackend): Promise<HarnessWebProxy> {
  const proxy = new HarnessWebProxy(backend);
  app.addHook("onClose", async () => proxy.reset());
  app.get("/harness", async (_req, reply) => reply.redirect(PREFIX));
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    // 透传原始 body：JSON RPC、文件上传和下载都由原版处理，不在这里解析或重组。
    scope.addContentTypeParser("*", (_req, stream, done) => done(null, stream));
    scope.route({ method: "GET", url: "/harness/*",
      handler: (req, reply) => proxy.http(req, reply), wsHandler: (ws, req) => proxy.websocket(ws, req),
    });
    scope.route({ method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"], url: "/harness/*",
      handler: (req, reply) => proxy.http(req, reply),
    });
  });
  return proxy;
}
