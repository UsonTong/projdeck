import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "@projdeck/shared";
import { summarizeInput } from "./jsonl.ts";

/*
 * Pi（pi coding agent）的会话文件：~/.pi/agent/sessions/--<路径>--/<时间>_<会话id>.jsonl，
 * 格式见 pi 自带的 docs/session-format.md。<路径> 是 cwd 去掉开头的分隔符、把 / \ : 换成 -。
 */

const sessionsDir = join(homedir(), ".pi", "agent", "sessions");

export function piSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export interface PiSession {
  file: string;
  sessionId: string;
  mtimeMs: number;
}

/**
 * herdr 报的 agent_session 是会话文件的完整路径（kind=path）；兼容直接给 id 的情况。
 * 文件名是 <时间>_<id>.jsonl，id 里没有下划线。
 */
export function piSessionId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.endsWith(".jsonl") ? sessionIdOf(value) : value;
}

function sessionIdOf(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1, -".jsonl".length);
  return name.slice(name.indexOf("_") + 1);
}

/** 某个目录下的 pi 会话，最近修改的在前。 */
export function listPiSessions(cwd: string): PiSession[] {
  const dir = join(sessionsDir, piSessionDirName(cwd));
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const file = join(dir, f);
        return { file, sessionId: sessionIdOf(file), mtimeMs: statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

/** 按会话 id 找。会话文件在第一条消息之后才会出现，找不到时返回 null。 */
export function findPiSession(cwd: string, sessionId: string): PiSession | null {
  return listPiSessions(cwd).find((s) => s.sessionId === sessionId) ?? null;
}

type Block =
  | { type: "text"; text: string }
  | { type: "image" }
  | { type: "thinking"; thinking?: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

interface PiRecord {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: { role?: string; content?: string | Block[] };
}

/** 把 pi 的 jsonl 记录转成聊天气泡。系统消息、工具结果、思考过程不显示。 */
export function parsePiRecords(records: unknown[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const raw of records) {
    const r = raw as PiRecord;
    if (r.type !== "message" || !r.message || !r.id) continue;
    const { role, content } = r.message;
    const time = r.timestamp;
    if (role === "user") {
      const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
      const text = blocks
        .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) entries.push({ kind: "user", id: r.id, text, images: [], time });
    } else if (role === "assistant" && Array.isArray(content)) {
      content.forEach((b, i) => {
        const id = `${r.id}:${i}`;
        if (b.type === "text" && b.text.trim()) entries.push({ kind: "assistant", id, text: b.text, time });
        else if (b.type === "toolCall") entries.push({ kind: "tool", id, name: b.name, summary: summarizeInput(b.arguments), time });
      });
    }
  }
  return entries;
}
