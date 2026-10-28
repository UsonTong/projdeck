import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type {
  CreateProjectBody,
  KeysBody,
  PromptBody,
  StartSessionBody,
  UpdateProjectBody,
} from "@projdeck/shared";
import { LoginLimiter, SESSION_COOKIE, SESSION_TTL_MS, SessionStore, verifyPassword } from "./auth.ts";
import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr/client.ts";
import { LiveHub } from "./live.ts";
import { TerminalBridge } from "./terminal.ts";
import { httpError, type ProjdeckService } from "./service.ts";
import { isAllowedMime, saveUpload } from "./uploads.ts";

/** 解析 Origin 头的 host；格式异常（如 "null"）时返回 null，按跨站处理。 */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

export async function buildServer(config: Config, service: ProjdeckService, herdr: HerdrClient) {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // 生产环境经服务器 Caddy → SSH 隧道 → 本机，真实 IP 在 X-Forwarded-For 中
    trustProxy: "127.0.0.1",
    bodyLimit: 1024 * 1024,
  });
  const sessions = new SessionStore();
  const limiter = new LoginLimiter();
  const live = new LiveHub(service, herdr);
  const terminals = new TerminalBridge(config, service);
  app.addHook("onClose", async () => terminals.closeAll());

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  await app.register(websocket, { options: { perMessageDeflate: true, maxPayload: 64 * 1024 } });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    void reply.status(status).send({ error: err.message });
  });

  const authed = (req: FastifyRequest) => sessions.valid(req.cookies[SESSION_COOKIE]);

  // 除登录外所有 /api 与 /ws 都需要登录
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0]!;
    const isWs = url === "/ws" || url === "/ws/term";
    if (!url.startsWith("/api/") && !isWs) return;
    if (url === "/api/auth/login" || url === "/api/auth/status") return;
    if (!authed(req)) return reply.status(401).send({ error: "未登录" });
    // WebSocket 与写操作校验 Origin，防止跨站请求
    if (isWs || req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && originHost(origin) !== req.headers.host) return reply.status(403).send({ error: "来源不被允许" });
    }
  });

  // ---- 认证 ----

  app.get("/api/auth/status", async (req) => ({ authenticated: authed(req), configured: config.passwordHash !== null }));

  app.post<{ Body: { password?: string } }>("/api/auth/login", async (req, reply) => {
    if (limiter.blocked(req.ip)) throw httpError(429, "尝试次数过多，请 15 分钟后再试");
    if (!(await verifyPassword(req.body?.password ?? "", config.passwordHash))) {
      limiter.fail(req.ip);
      throw httpError(401, config.passwordHash ? "密码错误" : "尚未设置密码，请在本机运行 pnpm cli set-password");
    }
    limiter.reset(req.ip);
    const token = sessions.create(req.headers["user-agent"] ?? "");
    void reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: req.protocol === "https",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    sessions.revoke(req.cookies[SESSION_COOKIE]);
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/revoke-all", async (_req, reply) => {
    sessions.revokeAll();
    void reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---- 总览与项目 ----

  app.get("/api/overview", async () => service.overview());
  app.get("/api/projects/suggestions", async () => service.suggestions());

  app.post<{ Body: CreateProjectBody }>("/api/projects", async (req) => {
    const body = req.body;
    const project = "path" in body ? service.importProject(body.path, body.name) : service.createProject(body.name);
    live.scheduleOverview();
    return project;
  });

  app.patch<{ Params: { id: string }; Body: UpdateProjectBody }>("/api/projects/:id", async (req) => {
    const project = service.updateProject(req.params.id, req.body);
    live.scheduleOverview();
    return project;
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    service.removeProject(req.params.id);
    live.scheduleOverview();
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: StartSessionBody }>("/api/projects/:id/sessions", async (req) => {
    const result = await service.startSession(req.params.id, req.body.kind);
    live.scheduleOverview();
    return result;
  });

  // ---- 会话 ----

  type PaneParams = { Params: { paneId: string } };

  app.get<PaneParams & { Querystring: { lines?: string } }>("/api/sessions/:paneId/output", async (req) => ({
    text: await service.output(req.params.paneId, req.query.lines ? Number(req.query.lines) : undefined),
  }));

  app.get<PaneParams & { Querystring: { cursor?: string } }>("/api/sessions/:paneId/transcript", async (req) =>
    service.transcript(req.params.paneId, req.query.cursor ? Number(req.query.cursor) : -1),
  );

  app.post<PaneParams & { Body: PromptBody }>("/api/sessions/:paneId/prompt", async (req) => {
    await service.prompt(req.params.paneId, req.body.text ?? "", req.body.images);
    live.scheduleOverview();
    return { ok: true };
  });

  app.post<PaneParams & { Body: KeysBody }>("/api/sessions/:paneId/keys", async (req) => {
    await service.keys(req.params.paneId, req.body.keys ?? []);
    return { ok: true };
  });

  app.post<PaneParams & { Body: { hidden: boolean } }>("/api/sessions/:paneId/hidden", async (req) => {
    await service.setHidden(req.params.paneId, req.body.hidden);
    live.scheduleOverview();
    return { ok: true };
  });

  app.post<PaneParams>("/api/sessions/:paneId/archive", async (req) => {
    const item = await service.archive(req.params.paneId);
    live.scheduleOverview();
    return item;
  });

  app.get<PaneParams>("/api/sessions/:paneId/codex-candidates", async (req) => service.codexCandidates(req.params.paneId));

  app.post<PaneParams & { Body: { threadId: string | null } }>("/api/sessions/:paneId/codex-conversation", async (req) => {
    await service.setCodexConversation(req.params.paneId, req.body.threadId);
    live.scheduleOverview();
    return { ok: true };
  });

  // ---- 归档 ----

  app.post<{ Params: { id: string } }>("/api/archive/:id/restore", async (req) => {
    const result = await service.restore(req.params.id);
    live.scheduleOverview();
    return result;
  });

  app.delete<{ Params: { id: string } }>("/api/archive/:id", async (req) => {
    service.deleteArchive(req.params.id);
    live.scheduleOverview();
    return { ok: true };
  });

  // ---- 图片 ----

  app.post<{ Params: { id: string } }>("/api/projects/:id/uploads", async (req) => {
    const project = (await service.overview()).projects.find((p) => p.id === req.params.id);
    if (!project) throw httpError(404, "项目不存在");
    const file = await req.file();
    if (!file) throw httpError(400, "没有收到文件");
    if (!isAllowedMime(file.mimetype)) throw httpError(415, `不支持的图片格式：${file.mimetype}`);
    return saveUpload(project.path, file.mimetype, file.file);
  });

  /** 预览图片：只允许读取项目内的文件，用于聊天气泡中的缩略图。 */
  app.get<{ Querystring: { path: string; project: string } }>("/api/file", async (req, reply) => {
    const { path, project } = req.query;
    // projectContains 对不存在的文件也返回 false，避免通过状态码探测项目外的文件是否存在
    if (!path || !project || !service.projectContains(project, path) || !/\.(png|jpe?g|webp|gif)$/i.test(path)) {
      throw httpError(403, "不允许访问该文件");
    }
    const real = realpathSync(path);
    return reply.sendFile(basename(real), dirname(real), { maxAge: 86_400_000, immutable: true });
  });

  // ---- WebSocket ----

  app.get("/ws", { websocket: true }, (socket) => live.add(socket));

  app.get<{ Querystring: { pane?: string; cols?: string; rows?: string } }>(
    "/ws/term",
    { websocket: true },
    (socket, req) => {
      const { pane, cols, rows } = req.query;
      if (!pane) return socket.close();
      void terminals.open(socket, pane, Number(cols), Number(rows));
    },
  );

  // ---- 前端静态文件（本机 / 局域网直接访问时使用；服务器部署时由 Caddy 反代整个站点） ----

  if (existsSync(webDist)) {
    // wildcard 模式按请求查找文件，重新构建前端后无需重启 agentd
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "接口不存在" });
      return reply.sendFile("index.html");
    });
  } else {
    // 未构建前端时仍需注册，以便 /api/file 使用 reply.sendFile
    await app.register(fastifyStatic, { root: process.cwd(), serve: false });
  }

  return app;
}
