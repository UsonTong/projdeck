import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export const UPLOAD_DIR = ".uploads";
const MAX_BYTES = 20 * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function isAllowedMime(mime: string): boolean {
  return mime in EXT_BY_MIME;
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 把 .uploads/ 加入 .git/info/exclude：不污染仓库，也不改动项目的 .gitignore。 */
async function excludeFromGit(projectPath: string): Promise<void> {
  const gitDir = join(projectPath, ".git");
  if (!existsSync(gitDir) || !(await stat(gitDir)).isDirectory()) return;
  const exclude = join(gitDir, "info", "exclude");
  const content = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  if (content.split("\n").some((l) => l.trim() === `${UPLOAD_DIR}/` || l.trim() === `/${UPLOAD_DIR}/`)) return;
  await mkdir(join(gitDir, "info"), { recursive: true });
  await appendFile(exclude, `${content && !content.endsWith("\n") ? "\n" : ""}# projdeck 上传的图片\n/${UPLOAD_DIR}/\n`);
}

export async function saveUpload(projectPath: string, mime: string, stream: Readable): Promise<{ path: string; name: string }> {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw Object.assign(new Error(`不支持的图片格式：${mime}`), { statusCode: 415 });
  const dir = join(projectPath, UPLOAD_DIR);
  await mkdir(dir, { recursive: true });
  await excludeFromGit(projectPath);

  const name = `${timestamp()}-${randomBytes(2).toString("hex")}.${ext}`;
  const path = join(dir, name);
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) stream.destroy(Object.assign(new Error("图片超过 20MB"), { statusCode: 413 }));
  });
  try {
    await pipeline(stream, createWriteStream(path, { mode: 0o600 }));
  } catch (err) {
    await unlink(path).catch(() => {});
    throw err;
  }
  return { path, name };
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
