import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type {
  CreateProjectBody,
  KeysBody,
  PromptBody,
  Settings,
  StartSessionBody,
  UpdateProjectBody,
} from "@projdeck/shared";
import { ACCESS_KEY_COOKIE, AccessKey, LoginLimiter, SESSION_COOKIE, SESSION_TTL_MS, SessionStore, verifyPassword } from "./auth.ts";
import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr/client.ts";
import { deleteEntry, listDir, makeDir, MAX_FILE_BYTES, openForDownload, readText, renameEntry, saveToDir } from "./files.ts";
import { loadGhosttyTheme, watchGhosttyTheme } from "./ghosttyTheme.ts";
import { LiveHub } from "./live.ts";
import { TerminalBridge } from "./terminal.ts";
import { httpError, type ProjdeckService } from "./service.ts";
import { MAX_UPLOAD_BYTES, saveUpload } from "./uploads.ts";

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
  const accessKey = new AccessKey(config.accessKeyFile);
  if (accessKey.enabled) app.log.info("已启用访问 key：带有效 key 的请求无需密码");
  const limiter = new LoginLimiter();
  const live = new LiveHub(service, herdr);
  service.onSeen = () => live.scheduleOverview();
  const stopThemeWatch = watchGhosttyTheme(() => live.broadcast({ type: "theme" }));
  app.addHook("onClose", async () => stopThemeWatch());
  const terminals = new TerminalBridge(config, service);
  app.addHook("onClose", async () => terminals.closeAll());

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  await app.register(websocket, { options: { perMessageDeflate: true, maxPayload: 64 * 1024 } });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    void reply.status(status).send({ error: err.message });
  });

  // 已登录 = 有效的密码登录会话，或有效的访问 key（公网入口）
  const authed = (req: FastifyRequest) =>
    sessions.valid(req.cookies[SESSION_COOKIE]) || accessKey.valid(req.cookies[ACCESS_KEY_COOKIE]);

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
  app.get("/api/terminal-theme", async () => loadGhosttyTheme());

  // herdr 没在运行（电脑重启后还没开、或被关掉了）时从网页启动。服务端由 systemd 托管，见 deploy/herdr-server.service
  app.post("/api/herdr/start", async () => {
    if (herdr.online) return { ok: true };
    try {
      await promisify(execFile)("systemctl", ["--user", "start", config.herdrUnit], { timeout: 15_000 });
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr ?? "");
      throw httpError(
        500,
        /not (found|loaded)/i.test(stderr)
          ? `没有安装 ${config.herdrUnit}，见 deploy/herdr-server.service`
          : `启动失败：${stderr.trim() || (err as Error).message}`,
      );
    }
    herdr.reconnectNow();
    for (let i = 0; i < 20 && !herdr.online; i++) await new Promise((r) => setTimeout(r, 250));
    if (!herdr.online) throw httpError(502, "herdr 已启动，但暂时连不上，请稍后再看");
    return { ok: true };
  });

  app.patch<{ Body: Partial<Settings> }>("/api/settings", async (req) => {
    const settings = service.updateSettings(req.body ?? {});
    live.scheduleOverview();
    return settings;
  });
  app.get("/api/projects/suggestions", async () => service.suggestions());

  app.post<{ Body: CreateProjectBody }>("/api/projects", async (req) => {
    const body = req.body;
    const project = "path" in body ? service.importProject(body.path, body.name) : service.createProject(body.name, body.git ?? true);
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
    await service.prompt(req.params.paneId, req.body.text ?? "", req.body.files);
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

  app.post<PaneParams>("/api/sessions/:paneId/close", async (req) => {
    await service.close(req.params.paneId);
    live.scheduleOverview();
    return { ok: true };
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

  // ---- 文件管理器（范围限定在项目目录内，见 files.ts） ----

  type FilesReq = { Params: { id: string }; Querystring: { path?: string; hidden?: string } };
  const rootOf = (req: { params: { id: string } }) => service.projectPath(req.params.id);
  /** RFC 5987：中文文件名下载。 */
  const disposition = (kind: "attachment" | "inline", name: string) =>
    `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

  app.get<FilesReq>("/api/projects/:id/files", async (req) => listDir(rootOf(req), req.query.path ?? "", req.query.hidden === "1"));

  app.get<FilesReq>("/api/projects/:id/files/download", async (req, reply) => {
    const f = await openForDownload(rootOf(req), req.query.path ?? "");
    void reply.header("Content-Type", f.contentType).header("Content-Disposition", disposition("attachment", f.name));
    if (f.size !== undefined) void reply.header("Content-Length", f.size);
    return reply.send(f.stream);
  });

  /** 图片预览。只内联图片，并加沙箱 CSP：防止 SVG / HTML 等在本站域名下执行脚本。 */
  app.get<FilesReq>("/api/projects/:id/files/raw", async (req, reply) => {
    const f = await openForDownload(rootOf(req), req.query.path ?? "");
    const inline = /^image\/(png|jpeg|gif|webp)$/.test(f.contentType);
    void reply
      .header("Content-Type", inline ? f.contentType : "application/octet-stream")
      .header("Content-Disposition", disposition(inline ? "inline" : "attachment", f.name))
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("X-Content-Type-Options", "nosniff");
    return reply.send(f.stream);
  });

  app.get<FilesReq>("/api/projects/:id/files/text", async (req) => {
    const r = await readText(rootOf(req), req.query.path ?? "");
    return r ?? { binary: true };
  });

  app.post<FilesReq>("/api/projects/:id/files/upload", async (req) => {
    const root = rootOf(req);
    const saved: { name: string; size: number }[] = [];
    for await (const part of req.files({ limits: { fileSize: MAX_FILE_BYTES, files: 100 } })) {
      const r = await saveToDir(root, req.query.path ?? "", part.filename || "file", part.file);
      if (part.file.truncated) {
        await deleteEntry(root, [req.query.path, r.name].filter(Boolean).join("/")).catch(() => {});
        throw httpError(413, `${part.filename} 超过 1GB`);
      }
      saved.push(r);
    }
    return saved;
  });

  app.post<{ Params: { id: string }; Body: { path?: string; name: string } }>("/api/projects/:id/files/mkdir", async (req) => {
    await makeDir(rootOf(req), req.body.path ?? "", req.body.name);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { path: string; name: string } }>("/api/projects/:id/files/rename", async (req) => {
    await renameEntry(rootOf(req), req.body.path, req.body.name);
    return { ok: true };
  });

  app.delete<FilesReq>("/api/projects/:id/files", async (req) => {
    await deleteEntry(rootOf(req), req.query.path ?? "");
    return { ok: true };
  });

  // ---- 图片 ----

  app.post<{ Params: { id: string } }>("/api/projects/:id/uploads", async (req) => {
    const project = (await service.overview()).projects.find((p) => p.id === req.params.id);
    if (!project) throw httpError(404, "项目不存在");
    const file = await req.file();
    if (!file) throw httpError(400, "没有收到文件");
    const result = await saveUpload(project.path, file.filename, file.mimetype, file.file);
    // 达到大小上限时 busboy 截断而不报错，删掉写了一半的文件
    if (file.file.truncated) {
      await unlink(result.path).catch(() => {});
      throw httpError(413, "文件超过 50MB");
    }
    return result;
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

  app.get<{ Querystring: { pane?: string; cols?: string; rows?: string; sizing?: string } }>(
    "/ws/term",
    { websocket: true },
    (socket, req) => {
      const { pane, cols, rows, sizing } = req.query;
      if (!pane) return socket.close();
      const mode = sizing === "desktop" || sizing === "auto" ? sizing : "fit";
      void terminals.open(socket, pane, Number(cols), Number(rows), mode);
    },
  );

  // ---- 前端静态文件（本机 / 局域网直接访问时使用；服务器部署时由 Caddy 反代整个站点） ----

  if (existsSync(webDist)) {
    // wildcard 模式按请求查找文件，重新构建前端后无需重启 agentd
    await app.register(fastifyStatic, {
      root: webDist,
      // 构建时已生成 .br / .gz（packages/web/scripts/compress.mjs）
      preCompressed: true,
      // 文件名带内容哈希的资源永不变化，浏览器长期缓存，不必每次打开都向本机确认；index.html 仍每次确认，更新立即生效
      setHeaders: (reply, path) => {
        if (path.includes("/assets/")) reply.header("cache-control", "public, max-age=31536000, immutable");
      },
    });
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
