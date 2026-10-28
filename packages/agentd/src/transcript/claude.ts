import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "@projdeck/shared";
import { summarizeInput } from "./jsonl.ts";

const projectsDir = join(homedir(), ".claude", "projects");

/** Claude Code 把 cwd 中所有非字母数字字符替换为 - 作为目录名。 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function findClaudeTranscript(cwd: string, sessionId: string): string | null {
  const direct = join(projectsDir, claudeProjectDirName(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  // cwd 编码规则可能变化，或 claude 是在别的目录启动的：退化为全量查找
  try {
    for (const dir of readdirSync(projectsDir)) {
      const file = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(file)) return file;
    }
  } catch {
    // ~/.claude/projects 不存在
  }
  return null;
}

interface ClaudeRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { role?: string; content?: string | ContentBlock[] };
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image" }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result" }
  | { type: "thinking" };

const IMAGE_SOURCE = /^\[Image: source: (.+)\]$/;

/** 把 Claude Code 的 jsonl 记录转成聊天气泡。 */
export function parseClaudeRecords(records: unknown[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let lastUser: Extract<TranscriptEntry, { kind: "user" }> | undefined;

  for (const raw of records) {
    const r = raw as ClaudeRecord;
    if (r.isSidechain || !r.message || !r.uuid) continue;
    const time = r.timestamp;
    const content = r.message.content;

    if (r.type === "user") {
      const blocks: ContentBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
      const text = blocks
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) continue; // 纯 tool_result

      if (r.isMeta) {
        // 粘贴图片时，Claude Code 会追加一条 meta 消息记录原图路径
        const m = IMAGE_SOURCE.exec(text);
        if (m && lastUser) lastUser.images.push(m[1]!);
        continue;
      }
      lastUser = { kind: "user", id: r.uuid, text: text.replace(/\[Image #\d+\]\s*/g, ""), images: [], time };
      entries.push(lastUser);
    } else if (r.type === "assistant" && Array.isArray(content)) {
      content.forEach((b, i) => {
        const id = `${r.uuid}:${i}`;
        if (b.type === "text" && b.text.trim()) entries.push({ kind: "assistant", id, text: b.text, time });
        else if (b.type === "tool_use") entries.push({ kind: "tool", id, name: b.name, summary: summarizeInput(b.input), time });
      });
    }
  }
  return entries;
}
