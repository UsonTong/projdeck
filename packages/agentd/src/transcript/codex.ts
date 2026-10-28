import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptEntry } from "@projdeck/shared";
import { summarizeInput } from "./jsonl.ts";

const sessionsDir = join(homedir(), ".codex", "sessions");
/** 只在最近这些天的 rollout 中匹配，避免每次扫描全部历史。 */
const SCAN_DAYS = 14;

export interface CodexRollout {
  file: string;
  threadId: string;
  cwd: string;
  mtimeMs: number;
}

const metaCache = new Map<string, { mtimeMs: number; meta: { threadId: string; cwd: string } | null }>();

/** 读取 rollout 首行的 session_meta。首行可能很长，按需扩大读取范围。 */
async function readMeta(file: string): Promise<{ threadId: string; cwd: string } | null> {
  const fh = await open(file, "r");
  try {
    let size = 64 * 1024;
    for (;;) {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, 0);
      const text = buf.subarray(0, bytesRead).toString("utf8");
      const nl = text.indexOf("\n");
      if (nl < 0 && bytesRead === size && size < 16 * 1024 * 1024) {
        size *= 4;
        continue;
      }
      const line = nl < 0 ? text : text.slice(0, nl);
      const o = JSON.parse(line) as { type?: string; payload?: { id?: string; cwd?: string } };
      if (o.type !== "session_meta" || !o.payload?.id || !o.payload.cwd) return null;
      return { threadId: o.payload.id, cwd: o.payload.cwd };
    }
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

export async function listCodexRollouts(): Promise<CodexRollout[]> {
  const files: string[] = [];
  const now = new Date();
  for (let d = 0; d < SCAN_DAYS; d++) {
    const day = new Date(now.getTime() - d * 86_400_000);
    const dir = join(
      sessionsDir,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    );
    try {
      for (const f of await readdir(dir)) if (f.startsWith("rollout-") && f.endsWith(".jsonl")) files.push(join(dir, f));
    } catch {
      // 当天没有会话
    }
  }

  const rollouts: CodexRollout[] = [];
  for (const file of files) {
    const { mtimeMs } = await stat(file);
    let cached = metaCache.get(file);
    if (!cached) {
      // session_meta 写入后不再变化，按文件缓存即可
      cached = { mtimeMs, meta: await readMeta(file) };
      metaCache.set(file, cached);
    }
    if (cached.meta) rollouts.push({ file, mtimeMs, ...cached.meta });
  }
  return rollouts;
}

/**
 * 为同一 cwd 下的若干 Codex pane 匹配 rollout。
 * herdr 不提供 Codex 的会话 ID，只能启发式匹配：同 cwd 中最近修改的 rollout 依次分给各 pane。
 * 同一目录多个 Codex 同时运行时可能错配，界面上提供手动选择兜底。
 */
export function matchCodexRollouts(
  paneCwds: { terminalId: string; cwd: string }[],
  rollouts: CodexRollout[],
): Map<string, CodexRollout> {
  const result = new Map<string, CodexRollout>();
  const byCwd = new Map<string, CodexRollout[]>();
  for (const r of rollouts) {
    const list = byCwd.get(r.cwd) ?? [];
    list.push(r);
    byCwd.set(r.cwd, list);
  }
  for (const list of byCwd.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const used = new Map<string, number>();
  for (const p of paneCwds) {
    const list = byCwd.get(p.cwd);
    const i = used.get(p.cwd) ?? 0;
    if (list?.[i]) {
      result.set(p.terminalId, list[i]);
      used.set(p.cwd, i + 1);
    }
  }
  return result;
}

interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    call_id?: string;
    role?: string;
    name?: string;
    arguments?: string;
    input?: string;
    content?: { type: string; text?: string }[];
  };
}

/** Codex 注入的上下文消息（环境信息、AGENTS.md 等）不显示为用户消息。 */
const INJECTED = /^\s*(<environment_context>|<user_instructions>|<permissions|# AGENTS\.md|<turn_aborted>)/;

export function parseCodexRecords(records: unknown[], cursorBase: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  records.forEach((raw, i) => {
    const r = raw as CodexRecord;
    const p = r.payload;
    if (r.type !== "response_item" || !p) return;
    const id = p.id ?? p.call_id ?? `${cursorBase}:${i}`;
    const time = r.timestamp;

    if (p.type === "message") {
      const text = (p.content ?? [])
        .map((c) => c.text ?? "")
        .join("\n")
        .trim();
      if (!text) return;
      if (p.role === "user" && !INJECTED.test(text)) entries.push({ kind: "user", id, text, images: [], time });
      else if (p.role === "assistant") entries.push({ kind: "assistant", id, text, time });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      let input: unknown = p.input ?? p.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          // custom_tool_call 的 input 是纯文本
        }
      }
      entries.push({ kind: "tool", id, name: p.name ?? "tool", summary: summarizeInput(input), time });
    }
  });
  return entries;
}
