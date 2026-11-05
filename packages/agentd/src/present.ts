import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import type { PresentedResource } from "@projdeck/shared";
import { isWithin } from "./projects/attribution.ts";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ITEMS = 50;

export interface PresentEntry {
  item: PresentedResource;
  path: string;
}

/** Agent 主动展示给 projdeck 的资源（目前是本地图片）。只在内存里保留最近 50 个。 */
export class PresentStore {
  private readonly entries = new Map<string, PresentEntry>();
  private order: string[] = [];

  /** 解析并校验路径：必须是已登记的根目录（项目、上传目录、临时目录）里的图片。 */
  add(input: string, title: string | undefined, roots: string[]): PresentedResource {
    if (!input || !isAbsolute(input)) throw Object.assign(new Error("请给出绝对路径"), { statusCode: 400 });
    let path: string;
    try {
      path = realpathSync(resolve(input));
    } catch {
      throw Object.assign(new Error("文件不存在"), { statusCode: 404 });
    }
    const allowed = roots.some((root) => {
      try {
        return isWithin(path, realpathSync(root));
      } catch {
        return false;
      }
    });
    if (!allowed) throw Object.assign(new Error("只能展示项目目录、上传目录或临时目录里的文件"), { statusCode: 403 });
    const stat = statSync(path);
    if (!stat.isFile()) throw Object.assign(new Error("不是文件"), { statusCode: 400 });
    if (stat.size > MAX_BYTES) throw Object.assign(new Error("图片超过 50MB"), { statusCode: 413 });
    const mime = MIME[extname(path).toLowerCase()];
    if (!mime) throw Object.assign(new Error("目前只支持 png / jpg / gif / webp / avif 图片"), { statusCode: 415 });
    const id = randomUUID().slice(0, 12);
    const name = basename(path);
    const item: PresentedResource = {
      id,
      name,
      title: (title ?? "").trim().slice(0, 120) || name,
      mime,
      at: Date.now(),
      url: `/api/present/${id}`,
      // 让前端能显示来源目录，便于区分同名图片
      path: path,
    };
    this.entries.set(id, { item, path });
    this.order.push(id);
    while (this.order.length > MAX_ITEMS) this.entries.delete(this.order.shift()!);
    return item;
  }

  list(): PresentedResource[] {
    return [...this.order].reverse().map((id) => this.entries.get(id)!.item);
  }

  get(id: string): PresentEntry | undefined {
    return this.entries.get(id);
  }
}
