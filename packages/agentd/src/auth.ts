import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { configDir, readJson, writeJson } from "./config.ts";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "projdeck_session";
/** 公网入口（projdeck-edge nginx）设置的访问 key cookie，见 deploy/projdeck-edge.conf。 */
export const ACCESS_KEY_COOKIE = "projdeck_key";
/**
 * 被控端（手机上的 projdeck 被控端 App）专用：只能连 /ws/adb 这个转发通道，访问不了服务器的其他任何接口。
 * 由网页「设备」页生成，一台设备一把，可以单独吊销。和上面的访问 key 是两回事。
 */
export const AGENT_COOKIE = "projdeck_agent";

/**
 * 访问 key 校验：带有效 key 即视为已登录（公网入口只用 key，不再要密码）。
 * key 从文件读取（默认 ~/.config/projdeck/edge-key），文件不存在时不启用。比较哈希，避免时序侧信道。
 */
export class AccessKey {
  private readonly hash: Buffer | null;

  constructor(file: string) {
    let key = "";
    try {
      key = readFileSync(file, "utf8").trim();
    } catch {
      // 未配置公网入口
    }
    // 过短的 key 视为无效，防止误配置成弱口令
    this.hash = key.length >= 16 ? createHash("sha256").update(key).digest() : null;
  }

  get enabled(): boolean {
    return this.hash !== null;
  }

  valid(key: string | undefined): boolean {
    if (!this.hash || !key) return false;
    return timingSafeEqual(createHash("sha256").update(key).digest(), this.hash);
  }
}

export const SESSION_TTL_MS = 30 * 86_400_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

interface StoredSession {
  /** 只存 token 的 SHA-256，sessions.json 泄露也无法冒充登录。 */
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  userAgent: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class SessionStore {
  private readonly file = join(configDir, "sessions.json");
  private sessions: StoredSession[] = readJson<StoredSession[]>(this.file, []);

  create(userAgent: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.sessions = this.sessions.filter((s) => s.expiresAt > now);
    this.sessions.push({ tokenHash: sha256(token), createdAt: now, expiresAt: now + SESSION_TTL_MS, userAgent });
    writeJson(this.file, this.sessions);
    return token;
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const h = sha256(token);
    return this.sessions.some((s) => s.tokenHash === h && s.expiresAt > Date.now());
  }

  revoke(token: string | undefined): void {
    if (!token) return;
    const h = sha256(token);
    this.sessions = this.sessions.filter((s) => s.tokenHash !== h);
    writeJson(this.file, this.sessions);
  }

  revokeAll(): void {
    this.sessions = [];
    writeJson(this.file, this.sessions);
  }
}

/** 登录失败限流：同一 IP 15 分钟内最多失败 5 次。 */
export class LoginLimiter {
  private failures = new Map<string, number[]>();
  private readonly windowMs = 15 * 60_000;
  private readonly max = 5;

  blocked(ip: string): boolean {
    const now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    this.failures.set(ip, recent);
    return recent.length >= this.max;
  }

  fail(ip: string): void {
    const list = this.failures.get(ip) ?? [];
    list.push(Date.now());
    this.failures.set(ip, list);
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }
}

export interface AgentKeySummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface StoredAgentKey extends AgentKeySummary {
  /** 只存 token 的 SHA-256：文件泄露也无法冒充被控端 */
  tokenHash: string;
}

/** 被控端密钥：一台设备一把，只能用于 /ws/adb；每次用到更新 lastUsedAt（一分钟内不重复写盘）。 */
export class AgentKeys {
  private readonly file: string;
  private keys: StoredAgentKey[];
  private lastFlush = 0;

  constructor(file = join(configDir, "agent-keys.json")) {
    this.file = file;
    this.keys = readJson<StoredAgentKey[]>(file, []);
  }

  list(): AgentKeySummary[] {
    return this.keys.map(({ tokenHash: _t, ...rest }) => rest);
  }

  /** 生成一把新密钥，返回明文（只在这里出现一次，之后只有哈希）。 */
  issue(name: string): { key: AgentKeySummary; token: string } {
    const token = "pdagent_" + randomBytes(24).toString("base64url");
    const key: StoredAgentKey = {
      id: randomBytes(8).toString("hex"),
      name: name.trim().slice(0, 40) || "未命名设备",
      createdAt: Date.now(),
      lastUsedAt: null,
      tokenHash: sha256(token),
    };
    this.keys.push(key);
    writeJson(this.file, this.keys);
    const { tokenHash: _t, ...summary } = key;
    return { key: summary, token };
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const h = sha256(token);
    const found = this.keys.find((k) => k.tokenHash === h);
    if (!found) return false;
    found.lastUsedAt = Date.now();
    if (Date.now() - this.lastFlush > 60_000) {
      this.lastFlush = Date.now();
      writeJson(this.file, this.keys);
    }
    return true;
  }

  revoke(id: string): boolean {
    const before = this.keys.length;
    this.keys = this.keys.filter((k) => k.id !== id);
    if (this.keys.length === before) return false;
    writeJson(this.file, this.keys);
    return true;
  }
}
