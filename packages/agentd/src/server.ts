import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
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
  DeviceView,
  KeysBody,
  PromptBody,
  Settings,
  StartSessionBody,
  UpdateProjectBody,
} from "@projdeck/shared";
import { ACCESS_KEY_COOKIE, AGENT_COOKIE, AccessKey, AgentKeys, LoginLimiter, SESSION_COOKIE, SESSION_TTL_MS, SessionStore, verifyPassword } from "./auth.ts";
import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr/client.ts";
import {
  deleteEntry,
  listDir,
  makeDir,
  MAX_FILE_BYTES,
  openForDownload,
  readForEdit,
  readText,
  renameEntry,
  saveToDir,
  writeText,
} from "./files.ts";
import { DesktopFocus } from "./desktopFocus.ts";
import type { PushService } from "./push.ts";
import { loadGhosttyTheme, watchGhosttyTheme } from "./ghosttyTheme.ts";
import { LiveHub } from "./live.ts";
import { TerminalBridge } from "./terminal.ts";
import { httpError, type ProjdeckService } from "./service.ts";
import { MAX_UPLOAD_BYTES, saveUpload, SHARED_UPLOAD_ROOT } from "./uploads.ts";
import { AdbRelay, parseReport } from "./adbRelay.ts";
import { CcSwitch } from "./ccswitch.ts";
import { NotifyStream } from "./notifyStream.ts";
import { CcSwitchBridge, type CcSwitchEvent } from "./ccswitchBridge.ts";
import { readUsage } from "./ccswitchUsage.ts";
import { registerHarnessWeb } from "./harness/webProxy.ts";

/** 解析 Origin 头的 host；格式异常（如 "null"）时返回 null，按跨站处理。 */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");

export async function buildServer(config: Config, service: ProjdeckService, herdr: HerdrClient, push: PushService, notifyStream = new NotifyStream()) {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // 生产环境经服务器 Caddy → SSH 隧道 → 本机，真实 IP 在 X-Forwarded-For 中
    trustProxy: "127.0.0.1",
    bodyLimit: 1024 * 1024,
  });
  const sessions = new SessionStore();
  const accessKey = new AccessKey(config.accessKeyFile);
  // 被控端密钥只能连 /ws/adb，不算「已登录」，访问不了其他接口
  const agentKeys = new AgentKeys();
  if (accessKey.enabled) app.log.info("已启用访问 key：带有效 key 的请求无需密码");
  const limiter = new LoginLimiter();
  const live = new LiveHub(service, herdr);
  app.addHook("onClose", async () => service.harness.close());
  service.onSeen = () => live.scheduleOverview();
  const stopThemeWatch = watchGhosttyTheme(() => live.broadcast({ type: "theme" }));
  app.addHook("onClose", async () => stopThemeWatch());
  // 电脑上 Ghostty 是否被切到前台（终端尺寸「自动」模式用）
  const desktopFocus = new DesktopFocus();
  desktopFocus.start();
  app.addHook("onClose", async () => desktopFocus.stop());
  const terminals = new TerminalBridge(config, service, desktopFocus);
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
    const harnessWeb = url === "/harness" || url.startsWith("/harness/");
    const isWs = url === "/ws" || url === "/ws/term" || url === "/ws/adb" || (harnessWeb && req.headers.upgrade?.toLowerCase() === "websocket");
    if (!url.startsWith("/api/") && !isWs && !harnessWeb) return;
    if (url === "/api/auth/login" || url === "/api/auth/status") return;
    // 被控端只允许连转发通道；它的密钥对别的接口一概无效
    const agentOnly = url === "/ws/adb" && agentKeys.valid(req.cookies[AGENT_COOKIE]);
    if (!authed(req) && !agentOnly) return reply.status(401).send({ error: "未登录" });
    // WebSocket 与写操作校验 Origin，防止跨站请求
    if (isWs || req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && originHost(origin) !== req.headers.host) return reply.status(403).send({ error: "来源不被允许" });
    }
  });

  const harnessWebProxy = await registerHarnessWeb(app, service.harness);

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

  // CC Switch：检测到安装了就可以在网页上看用量、切换各应用的供应商（全局，之后新开的会话生效）
  const ccswitch = new CcSwitch(undefined, config.ccswitchInspector);
  const bridge = new CcSwitchBridge(config.ccswitchInspector);
  // 网页上的 CC Switch 原版界面：编译好的前端（deploy/ccswitch-ui/build.sh），加载前注入 ccswitchShim.js
  const uiRoot = join(homedir(), ".cache", "projdeck", "cc-switch-ui");
  const uiDir = () => {
    const installed = (() => {
      try {
        return execFileSync("rpm", ["-q", "--qf", "%{VERSION}", "cc-switch"], { encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    })();
    if (installed && existsSync(join(uiRoot, installed, "index.html"))) return { dir: join(uiRoot, installed), version: installed, exact: true };
    const any = existsSync(uiRoot) ? readdirSync(uiRoot).filter((v) => existsSync(join(uiRoot, v, "index.html"))).sort().pop() : undefined;
    return any ? { dir: join(uiRoot, any), version: any, exact: false } : null;
  };
  app.get("/api/ccswitch/bridge", async () => {
    const ui = uiDir();
    return { available: await bridge.available(), ui: ui ? { version: ui.version, exact: ui.exact } : null };
  });
  app.post("/api/ccswitch/bridge/enable", async () => {
    await ccswitch.enableBridge();
    for (let i = 0; i < 40; i++) {
      if (await bridge.available()) return { available: true };
      await new Promise((r) => setTimeout(r, 500));
    }
    throw httpError(504, "CC Switch 重启后调试端口没有出现");
  });
  // 会在电脑屏幕上弹出窗口、或者控制它的窗口和进程的命令，网页不能转发（界面里的替身已经拦下，这里再挡一次）
  const desktopOnly = /^(plugin:(window|webview|process|dialog|opener|updater)\||open_file_dialog$|open_zip_file_dialog$|save_file_dialog$|pick_directory$|open_app_config_folder$|open_config_folder$|open_cc_switch_skills_dir$|open_workspace_directory$|reveal_|launch_session_terminal$|open_provider_terminal$|launch_hermes_dashboard$|open_hermes_web_ui$|restart_app$|install_update_and_restart$|open_portable_update_download$|set_window_theme$|tray_panel_)/;
  app.post<{ Body: { cmd?: string; args?: unknown } }>("/api/ccswitch/invoke", { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const cmd = String(req.body?.cmd ?? "");
    if (!/^[\w:|-]+$/.test(cmd)) throw httpError(400, "命令无效");
    if (desktopOnly.test(cmd)) throw httpError(403, "这个操作要在电脑上的 CC Switch 里做");
    return { result: (await bridge.invoke(cmd, req.body?.args ?? {})) ?? null };
  });
  // CC Switch 推给界面的事件（Server-Sent Events）
  app.get<{ Querystring: { e?: string } }>("/api/ccswitch/events", async (req, reply) => {
    const names = new Set((req.query.e ?? "").split(",").filter(Boolean));
    await Promise.all([...names].map((n) => bridge.listen(n).catch(() => undefined)));
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", connection: "keep-alive" });
    const onEvent = (e: CcSwitchEvent) => names.has(e.event) && reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    bridge.on("event", onEvent);
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      bridge.off("event", onEvent);
      clearInterval(ping);
    });
  });
  const shim = readFileSync(new URL("./ccswitchShim.js", import.meta.url), "utf8");
  app.get("/ccswitch-ui/projdeck-shim.js", async (_req, reply) => reply.type("text/javascript").header("cache-control", "no-cache").send(shim));
  app.get("/ccswitch-ui/", async (_req, reply) => {
    const ui = uiDir();
    if (!ui) throw httpError(404, "还没有编译 CC Switch 的界面，请运行 deploy/ccswitch-ui/build.sh");
    const html = readFileSync(join(ui.dir, "index.html"), "utf8").replace("<head>", '<head>\n    <script src="./projdeck-shim.js"></script>');
    return reply.type("text/html").header("cache-control", "no-cache").send(html);
  });
  app.get<{ Params: { "*": string } }>("/ccswitch-ui/assets/*", async (req, reply) => {
    const ui = uiDir();
    const name = req.params["*"];
    if (!ui || name.includes("..")) throw httpError(404, "文件不存在");
    return reply.sendFile(name, join(ui.dir, "assets"), { maxAge: 31_536_000_000, immutable: true });
  });
  app.get("/api/ccswitch", async () => ccswitch.status());
  app.get<{ Querystring: { range?: string; app?: string } }>("/api/ccswitch/usage", async (req) => {
    if (!ccswitch.installed()) throw httpError(404, "没有检测到 CC Switch");
    const range = (["today", "7d", "30d", "all"] as const).find((r) => r === req.query.range) ?? "7d";
    return readUsage(ccswitch.dbFile, range, req.query.app || null);
  });
  app.post<{ Body: { app: string; id: string } }>("/api/ccswitch/switch", async (req) => {
    const r = await ccswitch.switchProvider(String(req.body?.app ?? ""), String(req.body?.id ?? ""));
    return { ...(await ccswitch.status()), launched: r.launched };
  });

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
  app.get<{ Querystring: { path?: string } }>("/api/folders", async (req) => service.listFolders(req.query.path ?? "~"));

  app.post<{ Body: CreateProjectBody }>("/api/projects", async (req) => {
    const body = req.body;
    const project = "path" in body ? service.importProject(body.path, body.name) : service.createProject(body.name, body.git ?? true);
    live.scheduleOverview();
    return project;
  });

  // ---- 推送通知（手机上的完成 / 需处理提醒，见 notifier.ts）----
  type PushBody = { Body: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string } };
  app.get("/api/push/key", async () => ({ publicKey: push.publicKey }));
  app.post<PushBody>("/api/push/status", async (req) => ({ subscribed: push.has(String(req.body?.endpoint ?? "")) }));
  app.post<PushBody>("/api/push/subscribe", async (req) => {
    const { endpoint, keys, label } = req.body ?? {};
    if (!endpoint?.startsWith("https://") || !keys?.p256dh || !keys.auth) throw httpError(400, "订阅信息无效");
    push.subscribe({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, label: String(label ?? "").slice(0, 80) });
    return { ok: true };
  });
  app.post<PushBody>("/api/push/unsubscribe", async (req) => {
    push.unsubscribe(String(req.body?.endpoint ?? ""));
    return { ok: true };
  });
  app.post<PushBody>("/api/push/test", async (req) => {
    const delivered = await push.send(
      { title: "projdeck 通知测试", body: "能看到这条，说明这台设备会收到完成 / 需处理的提醒。", url: "/" },
      String(req.body?.endpoint ?? ""),
    );
    if (!delivered) throw httpError(502, "推送服务没有接受这条通知，请重新开启通知");
    return { ok: true };
  });

  // 安卓 App 的安装包（packages/mobile/release.sh 发布），手机在网页设置里下载安装
  const appDir = join(homedir(), ".cache", "projdeck", "android");
  app.get("/api/app", async () => {
    try {
      return JSON.parse(readFileSync(join(appDir, "version.json"), "utf8")) as { version: string; size: number; builtAt: string };
    } catch {
      return null;
    }
  });
  app.get("/app/projdeck.apk", async (_req, reply) => {
    if (!existsSync(join(appDir, "projdeck.apk"))) throw httpError(404, "还没有发布安卓 App");
    void reply.header("Content-Type", "application/vnd.android.package-archive").header("Content-Disposition", 'attachment; filename="projdeck.apk"');
    return reply.sendFile("projdeck.apk", appDir, { maxAge: 0, cacheControl: false });
  });
  // 独立的「被控端」App（packages/agent）：只负责被远程控制，不含 projdeck 的界面
  app.get("/app/projdeck-agent.json", async (_req, reply) => {
    if (!existsSync(join(appDir, "projdeck-agent.json"))) throw httpError(404, "还没有发布被控端 App");
    void reply.header("Cache-Control", "no-store");
    return reply.send(readFileSync(join(appDir, "projdeck-agent.json"), "utf8"));
  });
  app.get("/app/projdeck-agent.apk", async (_req, reply) => {
    if (!existsSync(join(appDir, "projdeck-agent.apk"))) throw httpError(404, "还没有发布被控端 App");
    void reply.header("Content-Type", "application/vnd.android.package-archive").header("Content-Disposition", 'attachment; filename="projdeck-agent.apk"');
    return reply.sendFile("projdeck-agent.apk", appDir, { maxAge: 0, cacheControl: false });
  });

  // 远程 adb：手机 App 连上 /ws/adb，电脑上 adb 连 127.0.0.1:<adbRelayPort>（见 adbRelay.ts、docs/REMOTE_ADB.md）
  const adbRelay = new AdbRelay(config.adbRelayPort, "127.0.0.1", (m) => app.log.info(m));
  app.addHook("onClose", async () => adbRelay.stop());
  app.get("/api/adb", async () => ({ ...adbRelay.status(), command: `adb connect 127.0.0.1:${config.adbRelayPort}` }));
  // 被控端密钥：生成后只在生成时显示一次；一台设备一把，可以单独吊销
  app.get("/api/agents", async () => ({ keys: agentKeys.list() }));
  app.post<{ Body: { name?: string } }>("/api/agents", async (req) => agentKeys.issue(String(req.body?.name ?? "")));
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    if (!agentKeys.revoke(req.params.id)) throw httpError(404, "没有这把密钥");
    return reply.status(204).send();
  });

  app.get("/api/devices", async (): Promise<{ devices: DeviceView[] }> => {
    const d = adbRelay.device();
    if (!d) return { devices: [] };
    const st = adbRelay.status();
    const { id, model, brand, os, ...rest } = d.report;
    return {
      devices: [
        {
          ...rest,
          id,
          kind: "android",
          name: [brand, model].filter(Boolean).join(" "),
          model,
          brand,
          os,
          online: d.online,
          since: d.since,
          lastSeen: d.lastSeen,
          adb: d.online ? { command: `adb connect 127.0.0.1:${config.adbRelayPort}`, connections: st.connections } : null,
        },
      ],
    };
  });
  app.get("/ws/adb", { websocket: true }, (socket) => {
    const link = adbRelay.attach({
      send: (f) => socket.send(f, { binary: true }),
      bufferedAmount: () => socket.bufferedAmount,
      close: () => socket.close(),
    });
    socket.on("message", (data: Buffer | Buffer[] | ArrayBuffer, isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (isBinary) return link.receive(buf);
      // 文本消息是手机的自我介绍（JSON），见 DeviceReport
      try {
        const report = parseReport(JSON.parse(buf.toString("utf8")));
        if (report) link.report(report);
      } catch {
        // 格式不对就忽略
      }
    });
    socket.on("close", () => link.detach());
    socket.on("error", () => link.detach());
  });

  // 安卓 App 的通知连接（见 notifyStream.ts）
  app.get("/api/notify/stream", async (_req, reply) => {
    reply.hijack();
    notifyStream.add(reply.raw);
  });
  app.post("/api/notify/test", async () => {
    const n = notifyStream.send({ title: "projdeck 测试通知", body: "能看到这条，说明 App 的通知可以正常收到", tag: "test", url: "/#/" });
    if (!n) throw httpError(409, "App 的通知连接还没有建立");
    return { ok: true };
  });

  app.post<{ Body: { ids?: string[] } }>("/api/projects/order", async (req) => {
    service.reorderProjects((req.body?.ids ?? []).map(String));
    live.scheduleOverview();
    return { ok: true };
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

  // 未归属：在主目录里新开 agent / 终端（不属于任何项目）
  app.post<{ Body: StartSessionBody }>("/api/sessions", async (req) => {
    const result = await service.startUnassignedSession(req.body.kind);
    live.scheduleOverview();
    return result;
  });

  // 独立的 Harness 后端。启动链接含凭据，只通过请求体接收，不返回、不写请求 URL 日志。
  app.get("/api/harness", async () => service.harness.status());
  app.put<{ Body: { connectionUrl?: string } }>("/api/harness", async (req) => {
    if (typeof req.body?.connectionUrl !== "string") throw httpError(400, "请粘贴本机 Harness 的启动链接");
    try {
      await service.configureHarness(req.body.connectionUrl);
    } finally {
      harnessWebProxy.reset();
      live.reconnectHarness();
    }
    return service.harness.status();
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

  app.post<PaneParams>("/api/sessions/:paneId/cancel", async (req) => {
    await service.cancel(req.params.paneId);
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

  app.post<PaneParams & { Body: { label?: string | null } }>("/api/sessions/:paneId/rename", async (req) => {
    await service.rename(req.params.paneId, req.body?.label ?? null);
    live.scheduleOverview();
    return { ok: true };
  });

  app.post<PaneParams & { Body: { beforePaneId?: string | null } }>("/api/sessions/:paneId/move-before", async (req) => {
    await service.moveBefore(req.params.paneId, req.body?.beforePaneId ?? null);
    live.scheduleOverview();
    return { ok: true };
  });

  app.post<PaneParams & { Body: { projectId: string } }>("/api/sessions/:paneId/project", async (req) => {
    await service.moveToProject(req.params.paneId, String(req.body?.projectId ?? ""));
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

  // 网页编辑器：读取完整内容与修改时间；保存时检查打开之后是否被改过（409 时由用户决定覆盖或重新加载）
  app.get<FilesReq>("/api/projects/:id/files/edit", async (req) => readForEdit(rootOf(req), req.query.path ?? ""));
  app.put<FilesReq & { Body: { path?: string; text?: string; baseMtimeMs?: number | null } }>(
    "/api/projects/:id/files/edit",
    { bodyLimit: 5 * 1024 * 1024 }, // 文件上限 2MB，JSON 转义后会变大
    async (req, reply) => {
      const { path = "", text, baseMtimeMs = null } = req.body ?? {};
      if (typeof text !== "string") throw httpError(400, "缺少文件内容");
      try {
        return await writeText(rootOf(req), path, text, typeof baseMtimeMs === "number" ? baseMtimeMs : null);
      } catch (e) {
        const conflict = e as { statusCode?: number; mtimeMs?: number; message: string };
        if (conflict.statusCode === 409) return reply.status(409).send({ error: conflict.message, mtimeMs: conflict.mtimeMs });
        throw e;
      }
    },
  );

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

  // 按会话上传（终端里粘贴 / 拖入、对话输入框的附件）：属于项目时存到项目的 .uploads/，未归属时存到共享目录
  app.post<PaneParams>("/api/sessions/:paneId/uploads", async (req) => {
    const root = (await service.uploadRootOf(req.params.paneId)) ?? SHARED_UPLOAD_ROOT;
    const file = await req.file();
    if (!file) throw httpError(400, "没有收到文件");
    const result = await saveUpload(root, file.filename, file.mimetype, file.file);
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

  app.get<{ Querystring: { pane?: string; cols?: string; rows?: string; sizing?: string; active?: string } }>(
    "/ws/term",
    { websocket: true },
    (socket, req) => {
      const { pane, cols, rows, sizing, active } = req.query;
      if (!pane) return socket.close();
      const mode = sizing === "desktop" || sizing === "auto" ? sizing : "fit";
      void terminals.open(socket, pane, Number(cols), Number(rows), mode, active !== "0");
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
