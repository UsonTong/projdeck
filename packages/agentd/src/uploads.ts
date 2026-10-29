import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { UploadResult } from "@projdeck/shared";

export const UPLOAD_DIR = ".uploads";

/** 不属于任何项目的会话，上传的文件放在这里（同样是其下的 .uploads/），不在用户的目录里新建文件夹。 */
export const SHARED_UPLOAD_ROOT = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "projdeck");
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

export const isImagePath = (p: string) => IMAGE_EXT.test(p);

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 保留原文件名（便于 agent 和人理解），但只允许字母（含中文）、数字和 . _ -：
 * 路径要原样写进发给 agent 的消息里，空格和 shell 特殊字符会让 agent 误判路径边界。
 */
export function safeFileName(original: string, mime: string): string {
  const base = original.split(/[\\/]/).pop() ?? "";
  let name = base
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[._]+/, "")
    .slice(-80);
  if (!name || name === "_") name = "file";
  if (!extname(name) && EXT_BY_MIME[mime]) name += `.${EXT_BY_MIME[mime]}`;
  return name;
}

/** 把 .uploads/ 加入 .git/info/exclude：不污染仓库，也不改动项目的 .gitignore。 */
async function excludeFromGit(projectPath: string): Promise<void> {
  const gitDir = join(projectPath, ".git");
  if (!existsSync(gitDir) || !(await stat(gitDir)).isDirectory()) return;
  const exclude = join(gitDir, "info", "exclude");
  const content = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  if (content.split("\n").some((l) => l.trim() === `${UPLOAD_DIR}/` || l.trim() === `/${UPLOAD_DIR}/`)) return;
  await mkdir(join(gitDir, "info"), { recursive: true });
  await appendFile(exclude, `${content && !content.endsWith("\n") ? "\n" : ""}# projdeck 上传的文件\n/${UPLOAD_DIR}/\n`);
}

/** 保存任意上传文件到 项目/.uploads/，文件名为「时间-随机-原名」，避免重名覆盖。 */
export async function saveUpload(projectPath: string, originalName: string, mime: string, stream: Readable): Promise<UploadResult> {
  const dir = join(projectPath, UPLOAD_DIR);
  await mkdir(dir, { recursive: true });
  await excludeFromGit(projectPath);

  const name = `${timestamp()}-${randomBytes(2).toString("hex")}-${safeFileName(originalName, mime)}`;
  const path = join(dir, name);
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_BYTES) stream.destroy(Object.assign(new Error("文件超过 50MB"), { statusCode: 413 }));
  });
  try {
    await pipeline(stream, createWriteStream(path, { mode: 0o600 }));
  } catch (err) {
    await unlink(path).catch(() => {});
    throw err;
  }
  return { path, name, size: bytes, image: isImagePath(name) };
}

/** 清理超过保留期的上传文件。 */
export async function pruneUploads(projectPaths: string[], retentionDays: number): Promise<number> {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  for (const projectPath of projectPaths) {
    const dir = join(projectPath, UPLOAD_DIR);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const file = join(dir, f);
      const s = await stat(file).catch(() => null);
      if (s?.isFile() && s.mtimeMs < cutoff) {
        await unlink(file).catch(() => {});
        removed++;
      }
    }
  }
  return removed;
}
