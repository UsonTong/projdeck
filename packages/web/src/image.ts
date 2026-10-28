/** 长边超过此值的图片在上传前缩小；对截图来说 2560 足够看清文字。 */
const MAX_EDGE = 2560;
/** 小于此大小且尺寸合适的图片原样上传，保留截图的清晰度。 */
const KEEP_BYTES = 4 * 1024 * 1024;

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/**
 * 上传前处理图片：手机照片通常 4000px+、5MB+，缩小后上传更快，agent 读取也更省 token。
 * HEIC 等浏览器能解码但服务端不接受的格式统一转为 JPEG。
 */
export async function prepareImage(file: File): Promise<{ blob: Blob; name: string }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    if (EXT[file.type]) return { blob: file, name: file.name || `image.${EXT[file.type]}` };
    throw new Error(`无法读取图片：${file.type || file.name}`);
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  if (scale === 1 && file.size <= KEEP_BYTES && EXT[file.type]) {
    bitmap.close();
    return { blob: file, name: file.name || `image.${EXT[file.type]}` };
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // 截图（PNG）保持 PNG 以免文字发糊，照片转 JPEG
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("图片压缩失败"))), type, 0.88),
  );
  return { blob, name: `image.${EXT[type]}` };
}
