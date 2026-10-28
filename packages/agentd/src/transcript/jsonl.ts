import { open } from "node:fs/promises";

/** 首次打开会话时只读文件末尾这么多字节，长会话也能秒开。 */
const TAIL_BYTES = 2 * 1024 * 1024;

export interface JsonlChunk {
  records: unknown[];
  cursor: number;
  reset: boolean;
}

/**
 * 从字节偏移 cursor 开始增量读取 JSONL，只消费完整的行。
 * cursor < 0 表示首次读取：从文件末尾 TAIL_BYTES 处开始，丢弃第一行残片。
 * cursor 超过文件大小（文件被截断或替换）时从头读，并标记 reset。
 */
export async function readJsonl(file: string, cursor: number): Promise<JsonlChunk> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    let reset = false;
    let start = cursor;
    if (cursor < 0 || cursor > size) {
      reset = cursor >= 0;
      start = Math.max(0, size - TAIL_BYTES);
    }
    if (start >= size) return { records: [], cursor: size, reset };

    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    let consumedStart = start;

    // 从文件中间开始读时，第一行是残片
    if (start > 0 && start !== cursor) {
      const nl = text.indexOf("\n");
      if (nl < 0) return { records: [], cursor: start, reset };
      consumedStart += Buffer.byteLength(text.slice(0, nl + 1));
      text = text.slice(nl + 1);
    }

    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { records: [], cursor: consumedStart, reset };
    const complete = text.slice(0, lastNl + 1);
    const records: unknown[] = [];
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // 跳过损坏的行，不让一行坏数据拖垮整个视图
      }
    }
    return { records, cursor: consumedStart + Buffer.byteLength(complete), reset };
  } finally {
    await fh.close();
  }
}

export function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** 从工具参数里挑出最能说明「在做什么」的字段。 */
export function summarizeInput(input: unknown): string {
  if (typeof input === "string") return truncate(input, 160);
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const key of ["description", "command", "cmd", "file_path", "path", "pattern", "url", "query", "prompt", "title"]) {
    const v = o[key];
    if (typeof v === "string" && v) return truncate(v, 160);
    if (Array.isArray(v) && v.length) return truncate(v.join(" "), 160);
  }
  return truncate(JSON.stringify(o), 160);
}
