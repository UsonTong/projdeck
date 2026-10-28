import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const home = homedir();

export const configDir = process.env.PROJDECK_CONFIG_DIR ?? join(home, ".config", "projdeck");

export interface Config {
  host: string;
  port: number;
  /** 新建项目的根目录。 */
  projectsRoot: string;
  herdrSocket: string;
  /** herdr 可执行文件。systemd 服务的 PATH 通常不含 ~/.local/bin，因此默认解析为绝对路径。 */
  herdrBin: string;
  /** scrypt 哈希，格式 salt:hash（hex）。未设置时拒绝所有登录。 */
  passwordHash: string | null;
  uploadRetentionDays: number;
}

const defaults: Config = {
  host: "127.0.0.1",
  port: 7420,
  projectsRoot: join(home, "Projects"),
  herdrSocket: join(home, ".config", "herdr", "herdr.sock"),
  herdrBin: [process.env.HERDR_BIN_PATH, join(home, ".local", "bin", "herdr")].find((p) => p && existsSync(p)) ?? "herdr",
  passwordHash: null,
  uploadRetentionDays: 30,
};

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`无法解析 ${file}: ${(err as Error).message}`);
  }
}

/** 先写临时文件再改名，避免进程中断时留下半个文件。 */
export function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

const configFile = join(configDir, "config.json");

export function loadConfig(): Config {
  const config = { ...defaults, ...readJson<Partial<Config>>(configFile, {}) };
  // 环境变量优先，便于开发时指向 herdr 测试会话
  if (process.env.PROJDECK_HERDR_SOCKET) config.herdrSocket = process.env.PROJDECK_HERDR_SOCKET;
  if (process.env.PROJDECK_PORT) config.port = Number(process.env.PROJDECK_PORT);
  if (process.env.PROJDECK_HOST) config.host = process.env.PROJDECK_HOST;
  return config;
}

export function saveConfig(patch: Partial<Config>): void {
  const current = readJson<Partial<Config>>(configFile, {});
  writeJson(configFile, { ...current, ...patch });
}
