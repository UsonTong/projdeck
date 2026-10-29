import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileEntry } from "@projdeck/shared";
import { isWithin } from "./projects/attribution.ts";

/** 文件管理器单个上传文件的上限。 */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** 文本预览的上限，超过只提供下载。 */
const MAX_PREVIEW_BYTES = 512 * 1024;
/** 网页里编辑的文件大小上限。 */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** 新建 / 重命名时的文件名：不能含路径分隔符，不能是 . 或 ..。 */
export function checkName(name: string): string {
  const n = name.trim();
  if (!n || n === "." || n === ".." || /[/\\\0]/.test(n) || n.length > 255) throw err(400, `文件名无效：${name}`);
  return n;
}

/**
 * 把项目内的相对路径解析成绝对路径，并保证结果在项目目录内。
 * 先解析 .. 再解析软链接后比较：`a/../../etc`、指向项目外的软链接都会被拒绝。
 * mustExist=false 用于新建：只要求父目录真实存在且在项目内。
 */
export async function resolveInProject(root: string, rel: string, mustExist = true): Promise<string> {
  const rootReal = await realpath(root);
  const target = resolve(rootReal, `.${sep}${rel.replace(/^[/\\]+/, "")}`);
  if (!isWithin(target, rootReal)) throw err(403, "路径不在项目内");
  if (mustExist) {
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      throw err(404, `文件不存在：${rel || "/"}`);
    }
    if (!isWithin(real, rootReal)) throw err(403, "路径不在项目内");
    return real;
  }
  let parent: string;
  try {
    parent = await realpath(dirname(target));
  } catch {
    throw err(404, "目标文件夹不存在");
  }
  if (!isWithin(parent, rootReal)) throw err(403, "路径不在项目内");
  return join(parent, basename(target));
}

/** 项目内的相对路径（给前端显示和拼接用，统一用 /）。 */
export const toRel = (rootReal: string, abs: string) => relative(rootReal, abs).split(sep).join("/");

export async function listDir(root: string, rel: string, showHidden: boolean): Promise<{ path: string; entries: FileEntry[] }> {
  const rootReal = await realpath(root);
  const dir = await resolveInProject(root, rel);
  if (!(await stat(dir)).isDirectory()) throw err(400, "不是文件夹");
  const names = await readdir(dir);
  const entries: FileEntry[] = [];
  for (const name of names) {
    if (!showHidden && name.startsWith(".")) continue;
    const abs = join(dir, name);
    const l = await lstat(abs).catch(() => null);
    if (!l) continue;
    // 软链接按目标类型显示；目标不存在（断链）时当作普通文件
    const s = l.isSymbolicLink() ? await stat(abs).catch(() => l) : l;
    entries.push({
      name,
      type: s.isDirectory() ? "dir" : "file",
      size: s.isDirectory() ? 0 : s.size,
      modifiedAt: s.mtime.toISOString(),
      symlink: l.isSymbolicLink(),
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "zh-CN", { numeric: true }) : a.type === "dir" ? -1 : 1));
  return { path: toRel(rootReal, dir), entries };
}

/** 同名文件不覆盖：a.txt → a (1).txt → a (2).txt …。 */
async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    const exists = await lstat(join(dir, candidate)).then(
      () => true,
      () => false,
    );
    if (!exists) return candidate;
  }
}

/** 上传到项目内的某个文件夹，保留原文件名（重名自动改名）。 */
export async function saveToDir(root: string, rel: string, filename: string, stream: Readable): Promise<{ name: string; size: number }> {
  const dir = await resolveInProject(root, rel);
  if (!(await stat(dir)).isDirectory()) throw err(400, "目标不是文件夹");
  const name = await freeName(dir, checkName(basename(filename.replace(/\\/g, "/"))));
  const path = join(dir, name);
  let size = 0;
  stream.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_FILE_BYTES) stream.destroy(err(413, "文件超过 1GB"));
  });
  try {
    // wx：再确认一次不覆盖已有文件（并发上传同名文件时）
    await pipeline(stream, createWriteStream(path, { flags: "wx" }));
  } catch (e) {
    await rm(path, { force: true });
    throw e;
  }
  return { name, size };
}

export async function makeDir(root: string, rel: string, name: string): Promise<string> {
  const parent = await resolveInProject(root, rel);
  const path = join(parent, checkName(name));
  await mkdir(path).catch((e: NodeJS.ErrnoException) => {
    throw e.code === "EEXIST" ? err(409, `已存在：${name}`) : e;
  });
  return path;
}

export async function renameEntry(root: string, rel: string, newName: string): Promise<void> {
  const rootReal = await realpath(root);
  const from = await resolveInProject(root, rel);
  if (from === rootReal) throw err(400, "不能重命名项目根目录");
  const to = join(dirname(from), checkName(newName));
  if (await lstat(to).then(() => true, () => false)) throw err(409, `已存在：${newName}`);
  await rename(from, to);
}

export async function deleteEntry(root: string, rel: string): Promise<void> {
  const rootReal = await realpath(root);
  if (resolve(rootReal, `.${sep}${rel.replace(/^[/\\]+/, "")}`) === rootReal) throw err(400, "不能删除项目根目录");
  // 删除软链接本身，不跟随到目标：只解析父目录
  const target = await resolveInProject(root, rel, false);
  await lstat(target).catch(() => {
    throw err(404, "文件不存在");
  });
  await rm(target, { recursive: true, force: false });
}

export interface FileStream {
  stream: Readable;
  name: string;
  size?: number;
  contentType: string;
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain",
};

/** 下载：文件直接读；文件夹用 tar 打包成 .tar.gz 流式输出。 */
export async function openForDownload(root: string, rel: string): Promise<FileStream> {
  const path = await resolveInProject(root, rel);
  const s = await stat(path);
  if (s.isDirectory()) {
    const tar = spawn("tar", ["-czf", "-", "-C", dirname(path), basename(path)], { stdio: ["ignore", "pipe", "ignore"] });
    return { stream: tar.stdout, name: `${basename(path)}.tar.gz`, contentType: "application/gzip" };
  }
  return {
    stream: createReadStream(path),
    name: basename(path),
    size: s.size,
    contentType: MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
  };
}

/** 文本预览：前 512KB，含 NUL 字节视为二进制不预览。 */
export async function readText(root: string, rel: string): Promise<{ text: string; truncated: boolean } | null> {
  const path = await resolveInProject(root, rel);
  const s = await stat(path);
  if (!s.isFile()) throw err(400, "不是文件");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(s.size, MAX_PREVIEW_BYTES));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.includes(0)) return null;
    return { text: buf.toString("utf8"), truncated: s.size > MAX_PREVIEW_BYTES };
  } finally {
    await fh.close();
  }
}

/** 读取文本文件用于编辑：完整内容和修改时间（保存时用来检查是否被别人改过）。 */
export async function readForEdit(root: string, rel: string): Promise<{ text: string; mtimeMs: number }> {
  const path = await resolveInProject(root, rel);
  const s = await stat(path);
  if (!s.isFile()) throw err(400, "不是文件");
  if (s.size > MAX_EDIT_BYTES) throw err(413, "文件超过 2MB，不能在网页里编辑，请下载后修改");
  const buf = await readFile(path);
  if (buf.includes(0)) throw err(415, "这是二进制文件，不能当文本编辑");
  return { text: buf.toString("utf8"), mtimeMs: s.mtimeMs };
}

/**
 * 保存编辑结果。baseMtimeMs 为打开时的修改时间：文件之后被改过（例如 agent 同时在改）时报 409，
 * 由用户决定覆盖还是重新加载；传 null 表示确认覆盖。
 * 先写到同目录的临时文件再改名替换，保存中途出错不会留下写了一半的文件；保留原文件的权限。
 */
export async function writeText(root: string, rel: string, text: string, baseMtimeMs: number | null): Promise<{ mtimeMs: number }> {
  const path = await resolveInProject(root, rel);
  const s = await stat(path);
  if (!s.isFile()) throw err(400, "不是文件");
  if (Buffer.byteLength(text) > MAX_EDIT_BYTES) throw err(413, "内容超过 2MB");
  if (baseMtimeMs !== null && Math.abs(s.mtimeMs - baseMtimeMs) > 1) {
    throw Object.assign(err(409, "文件在你打开之后被修改过"), { mtimeMs: s.mtimeMs });
  }
  const tmp = join(dirname(path), `.${basename(path)}.projdeck-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, text, { mode: s.mode & 0o7777 });
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  return { mtimeMs: (await stat(path)).mtimeMs };
}
