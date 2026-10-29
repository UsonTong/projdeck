import type { UploadResult } from "@projdeck/shared";
import { api } from "../api.ts";
import { prepareImage } from "../image.ts";

/** 上传任意文件到项目的 .uploads/：图片先压缩（手机照片动辄 5MB+），其他文件原样上传。 */
export async function uploadFile(projectId: string, file: File): Promise<UploadResult> {
  if (file.type.startsWith("image/") && file.type !== "image/gif") {
    const { blob, name } = await prepareImage(file);
    // 保留原文件名，但扩展名以实际格式为准（例如 HEIC 照片会被转成 JPEG）
    const ext = name.split(".").pop();
    const base = file.name.replace(/\.[^.]+$/, "") || "image";
    return api.upload(projectId, blob, `${base}.${ext}`);
  }
  return api.upload(projectId, file, file.name || "file");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
