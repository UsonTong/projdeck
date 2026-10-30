import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { CcSwitchStatus } from "@projdeck/shared";
import { configDir } from "./config.ts";
import { httpError } from "./service.ts";

const run = promisify(execFile);
const home = homedir();

/*
 * CC Switch（github.com/farion1231/cc-switch）的 Claude 供应商切换，按它 v4 的做法在外部完成。
 *
 * CC Switch 运行时把「当前供应商」缓存在内存里，不监听文件，也没有重新加载的手段：外部改了它不知道，
 * 它下次保存设置时还会写回旧值。所以切换时先停掉它，改完再启动（静默启动设置下不弹窗口）。
 *
 * 切换只改 ~/.claude/settings.json 里属于供应商的键，其余（hooks、插件、权限……）原样保留：
 * - 关键字段（地址、凭据、模型名、协议选择器）：一律清空，再写目标供应商的；
 * - 供应商独有字段（兼容开关、窗口值）：删掉上一家带进来、而且值没被改过的，再写目标的；
 * - 旧版残留的窗口值：删掉。
 * 规则与 CC Switch 4.0.19 的 live/floor.rs、live/residue.rs、live/project/claude.rs 一致。
 * 然后把 CC Switch 数据库里的 is_current 和它 settings.json 里的 currentProviderClaude 指过去。
 *
 * Codex 的切换牵涉登录状态、多个文件，不在这里做，仍在 CC Switch 里切。
 */

const FLOOR_TOP = new Set([
  "apiKeyHelper", "apiBaseUrl", "primaryModel", "smallFastModel", "apiKey", "model", "fallbackModel",
  "modelOverrides", "modelPicker", "advisorModel", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh",
]);
const FLOOR_ENV_PREFIXES = ["ANTHROPIC_", "AWS_", "VERTEX_REGION_"];
const FLOOR_ENV_KEYS = new Set([
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
]);
const EXCLUSIVE_ENV = new Set([
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_DISABLE_ARTIFACT", "ENABLE_TOOL_SEARCH", "CLAUDE_CODE_DISABLE_THINKING",
  "DISABLE_INTERLEAVED_THINKING", "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "CLAUDE_CODE_EXTRA_BODY",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING", "CLAUDE_CODE_AUTO_MODE_SERVER", "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
]);
const RESIDUE_ENV: Record<string, string[]> = {
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: ["262144", "372000", "983616"],
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: ["262144", "372000", "1000000"],
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: ["131072"],
};

const floorEnv = (key: string) =>
  FLOOR_ENV_PREFIXES.some((p) => key.startsWith(p)) || FLOOR_ENV_KEYS.has(key) || (key.startsWith("CLAUDE_CODE_SKIP_") && key.endsWith("_AUTH"));

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const truthy = (v: unknown) => v === true || v === 1 || (typeof v === "string" && ["1", "true", "yes", "on"].includes(v.toLowerCase()));

interface Projection {
  top: Json;
  env: Json;
  exclusive: Json;
}

/** 供应商配置里属于供应商的键。 */
function project(settings: unknown): Projection {
  const p: Projection = { top: {}, env: {}, exclusive: {} };
  if (!isObject(settings)) return p;
  for (const [k, v] of Object.entries(settings)) if (FLOOR_TOP.has(k)) p.top[k] = v;
  if (isObject(settings.env)) {
    for (const [k, v] of Object.entries(settings.env)) {
      if (floorEnv(k)) p.env[k] = v;
      else if (EXCLUSIVE_ENV.has(k)) p.exclusive[k] = v;
    }
  }
  // 旧 Bedrock API Key 预设把 Key 写在顶层 apiKey，Claude Code 读的是这个变量
  if (truthy(p.env.CLAUDE_CODE_USE_BEDROCK) && "apiKey" in p.top) {
    p.env.AWS_BEARER_TOKEN_BEDROCK ??= p.top.apiKey;
    delete p.top.apiKey;
  }
  return p;
}

/** 以当前的 settings.json 为底，算出切到 target 之后的内容（不写盘）。prev 是切换前的当前供应商的配置。 */
export function projectClaudeSettings(live: Json, prev: unknown | null, target: unknown): Json {
  const doc: Json = structuredClone(live);
  const t = project(target);
  const targetEnv = { ...t.env, ...t.exclusive };
  const env: Json = isObject(doc.env) ? doc.env : {};

  // 关键字段：清空（目标也有的键原位覆盖，保持键的顺序）
  for (const k of Object.keys(doc)) if (FLOOR_TOP.has(k) && !(k in t.top)) delete doc[k];
  for (const k of Object.keys(env)) if (floorEnv(k) && !(k in targetEnv)) delete env[k];
  // 写入目标的关键字段和独有字段
  Object.assign(doc, t.top);
  Object.assign(env, targetEnv);
  // 上一家带进来、值没被改过的独有字段
  if (prev !== null) {
    for (const [k, v] of Object.entries(project(prev).exclusive)) if (!(k in targetEnv) && k in env && sameJson(env[k], v)) delete env[k];
  }
  // 旧版残留的窗口值（字符串或数字写法）
  for (const [k, values] of Object.entries(RESIDUE_ENV)) {
    if (k in targetEnv || !(k in env)) continue;
    if (values.some((v) => env[k] === v || env[k] === Number(v))) delete env[k];
  }
  if (Object.keys(env).length > 0 || isObject(doc.env)) doc.env = env;
  return doc;
}

export interface CcSwitchPaths {
  /** CC Switch 的数据目录（cc-switch.db、settings.json、live-state.json）。 */
  dir: string;
  claudeSettings: string;
  /** CC Switch 可执行文件；用来找到正在运行的它。 */
  bin: string;
  /** 切换前的 ~/.claude/settings.json 备份到这里。 */
  backupDir: string;
}

export const defaultCcSwitchPaths = (): CcSwitchPaths => ({
  dir: process.env.PROJDECK_CCSWITCH_DIR ?? join(home, ".cc-switch"),
  claudeSettings: process.env.PROJDECK_CLAUDE_SETTINGS ?? join(home, ".claude", "settings.json"),
  bin: process.env.PROJDECK_CCSWITCH_BIN ?? "/usr/bin/cc-switch",
  backupDir: join(configDir, "backups", "claude-settings"),
});

/** 原子写入（同目录临时文件 + rename），权限 0600。保留原文件的缩进和结尾换行。 */
function writeJsonLike(file: string, value: unknown, original: string | null): void {
  const indent = original?.match(/^\{\s*\n([ \t]+)"/)?.[1] ?? "  ";
  const text = JSON.stringify(value, null, indent) + (original === null || original.endsWith("\n") ? "\n" : "");
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.projdeck-${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

/** 正在运行的 CC Switch：进程号，以及它所在的 systemd 用户服务（开机自启时是 app-CC Switch@autostart.service）。 */
function findRunning(bin: string): { pids: number[]; unit: string | null } {
  let target: string;
  try {
    target = realpathSync(bin);
  } catch {
    return { pids: [], unit: null };
  }
  const pids: number[] = [];
  let unit: string | null = null;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readlinkSync(`/proc/${name}/exe`) !== target) continue;
      pids.push(Number(name));
      const cgroup = readFileSync(`/proc/${name}/cgroup`, "utf8");
      const m = /\/user@\d+\.service\/(?:[^/]+\.slice\/)*([^/\n]+\.service)$/m.exec(cgroup.trim());
      // 名字里的空格在 cgroup 里是 \x20，systemctl 正好接受这种转义写法
      if (m) unit ??= m[1]!;
    } catch {
      // 进程已退出或无权限
    }
  }
  return { pids, unit };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class CcSwitch {
  private readonly paths: CcSwitchPaths;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(paths: CcSwitchPaths = defaultCcSwitchPaths()) {
    this.paths = paths;
  }

  private get db() {
    return join(this.paths.dir, "cc-switch.db");
  }

  installed(): boolean {
    return existsSync(this.db);
  }

  /** 不能在外部切换的原因（代理接管、有没做完的操作）；可以时为 null。 */
  private blocked(): string | null {
    const state = JSON.parse(readText(join(this.paths.dir, "live-state.json")) ?? "{}") as { apps?: Record<string, Json> };
    const apps = state.apps ?? {};
    const claude = apps.claude ?? {};
    if (claude.mode === "proxy" || claude.attached || claude.proxy_route) return "CC Switch 正在用本地代理接管 Claude，请在 CC Switch 里切换";
    if (Object.values(apps).some((a) => isObject(a) && a.pending)) return "CC Switch 有一个没做完的切换，请先在 CC Switch 里操作一次";
    return null;
  }

  private providers(): { id: string; name: string; config: unknown; isCurrent: boolean; website: string | null }[] {
    const db = new DatabaseSync(this.db, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const rows = db
        .prepare(
          "SELECT id, name, settings_config, is_current, website_url FROM providers WHERE app_type = 'claude' ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC",
        )
        .all() as { id: string; name: string; settings_config: string; is_current: number; website_url: string | null }[];
      return rows.map((r) => {
        let config: unknown = {};
        try {
          config = JSON.parse(r.settings_config);
        } catch {
          // 配置损坏的行照样列出，切换时会报错
        }
        return { id: r.id, name: r.name, config, isCurrent: !!r.is_current, website: r.website_url };
      });
    } finally {
      db.close();
    }
  }

  /** 当前供应商：以 CC Switch 设置里的指针为准，没有时用数据库的 is_current（与它自己的判断一致）。 */
  private currentId(providers: { id: string; isCurrent: boolean }[]): string | null {
    const settings = JSON.parse(readText(join(this.paths.dir, "settings.json")) ?? "{}") as { currentProviderClaude?: string };
    const pointer = settings.currentProviderClaude;
    if (pointer && providers.some((p) => p.id === pointer)) return pointer;
    return providers.find((p) => p.isCurrent)?.id ?? null;
  }

  status(): CcSwitchStatus {
    if (!this.installed()) return { installed: false, providers: [], current: null, blocked: null };
    const providers = this.providers();
    return {
      installed: true,
      providers: providers.map((p) => ({ id: p.id, name: p.name, website: p.website })),
      current: this.currentId(providers),
      blocked: this.blocked(),
    };
  }

  /** 切换 Claude 的供应商。同一时间只做一次。 */
  switchClaude(id: string): Promise<{ restarted: boolean }> {
    const next = this.busy.then(() => this.doSwitch(id));
    this.busy = next.catch(() => undefined);
    return next;
  }

  private async doSwitch(id: string): Promise<{ restarted: boolean }> {
    if (!this.installed()) throw httpError(404, "没有检测到 CC Switch");
    const reason = this.blocked();
    if (reason) throw httpError(409, reason);
    const before = this.providers();
    if (!before.some((p) => p.id === id)) throw httpError(404, "CC Switch 里没有这个供应商");
    if (this.currentId(before) === id) return { restarted: false };

    const running = findRunning(this.paths.bin);
    await this.stopGui(running);
    try {
      // 停下之后再读：它退出前可能刚写过
      const providers = this.providers();
      const target = providers.find((p) => p.id === id)!;
      const prevId = this.currentId(providers);
      if (prevId === id) return { restarted: running.pids.length > 0 };
      const prev = providers.find((p) => p.id === prevId) ?? null;

      // 1. Claude 的配置文件（先备份）
      const original = readText(this.paths.claudeSettings);
      const live = original === null ? {} : (JSON.parse(original) as unknown);
      if (!isObject(live)) throw httpError(500, `${this.paths.claudeSettings} 不是 JSON 对象，没有改动`);
      if (original !== null) this.backup(original);
      writeJsonLike(this.paths.claudeSettings, projectClaudeSettings(live, prev?.config ?? null, target.config), original);

      // 2. 数据库里的当前标记
      const db = new DatabaseSync(this.db);
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE providers SET is_current = 0 WHERE app_type = 'claude'").run();
          db.prepare("UPDATE providers SET is_current = 1 WHERE id = ? AND app_type = 'claude'").run(id);
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      } finally {
        db.close();
      }

      // 3. CC Switch 设置里的指针（其余设置原样保留）
      const settingsFile = join(this.paths.dir, "settings.json");
      const settingsText = readText(settingsFile);
      const settings = settingsText === null ? {} : (JSON.parse(settingsText) as Json);
      writeJsonLike(settingsFile, { ...settings, currentProviderClaude: id }, settingsText);
      return { restarted: running.pids.length > 0 };
    } finally {
      await this.startGui(running);
    }
  }

  /** 切换前的 ~/.claude/settings.json 留一份（只保留最近 10 份）。 */
  private backup(text: string): void {
    const dir = this.paths.backupDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, text, { mode: 0o600 });
    const old = readdirSync(dir).sort().slice(0, -10);
    for (const f of old) rmSync(join(dir, f), { force: true });
  }

  private async stopGui(running: { pids: number[]; unit: string | null }): Promise<void> {
    if (running.pids.length === 0) return;
    if (running.unit) await run("systemctl", ["--user", "stop", running.unit], { timeout: 15_000 });
    else for (const pid of running.pids) if (alive(pid)) process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 8_000;
    while (running.pids.some(alive)) {
      if (Date.now() > deadline) throw httpError(500, "CC Switch 没有退出，没有切换");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 按原来的方式启动：在原来的 systemd 服务里，或者作为独立的临时服务（不随 projdeck 一起被停掉）。 */
  private async startGui(running: { pids: number[]; unit: string | null }): Promise<void> {
    if (running.pids.length === 0) return;
    if (running.unit) await run("systemctl", ["--user", "start", running.unit], { timeout: 15_000 });
    else await run("systemd-run", ["--user", "--collect", "--quiet", "--", realpathSync(this.paths.bin)], { timeout: 15_000 });
  }
}
