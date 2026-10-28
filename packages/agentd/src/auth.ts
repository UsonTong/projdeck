import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { configDir, readJson, writeJson } from "./config.ts";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "projdeck_session";
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
