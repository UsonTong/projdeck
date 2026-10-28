// projdeck 前后端共享的 API 契约。只放类型，运行时为空。

export type AgentKind = "claude" | "codex";
export type SessionKind = AgentKind | "shell";
export type SessionStatus = "working" | "idle" | "blocked" | "done" | "unknown";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  archived: boolean;
  defaultAgent: AgentKind;
  agentArgs: Record<AgentKind, string[]>;
}

/** 一个 herdr pane，在 projdeck 中称为「会话」。 */
export interface Session {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  kind: SessionKind;
  status: SessionStatus;
  title: string;
  cwd: string;
  /** Claude session id / Codex thread id；未知时为 null。 */
  conversationId: string | null;
  hidden: boolean;
}

export interface ProjectView extends Project {
  sessions: Session[];
}

export interface ArchivedSession {
  id: string;
  projectId: string;
  kind: AgentKind;
  conversationId: string;
  title: string;
  cwd: string;
  archivedAt: string;
}

export interface Overview {
  herdr: { online: boolean; error?: string };
  projects: ProjectView[];
  unassigned: Session[];
  archived: ArchivedSession[];
}

export interface ProjectSuggestion {
  path: string;
  name: string;
  sessionCount: number;
}

// ---- 会话记录（聊天气泡） ----

export type TranscriptEntry =
  | { kind: "user"; id: string; text: string; images: string[]; time?: string }
  | { kind: "assistant"; id: string; text: string; time?: string }
  | { kind: "tool"; id: string; name: string; summary: string; time?: string };

export interface TranscriptPage {
  /** 会话记录不可用时为 null，前端回退到终端视图。 */
  conversationId: string | null;
  entries: TranscriptEntry[];
  /** 下次增量读取的游标（字节偏移）。 */
  cursor: number;
  /** cursor 超出文件（被截断或换了文件）时为 true，前端应丢弃旧数据。 */
  reset: boolean;
}

// ---- 请求体 ----

export type CreateProjectBody = { name: string } | { path: string; name?: string };
export interface UpdateProjectBody {
  name?: string;
  archived?: boolean;
  defaultAgent?: AgentKind;
}
export interface StartSessionBody {
  kind: SessionKind;
}
export interface PromptBody {
  text: string;
  images?: string[];
}
export interface KeysBody {
  keys: string[];
}
export interface UploadResult {
  path: string;
  name: string;
}

// ---- WebSocket ----

export type ClientMessage =
  | { op: "watch"; paneId: string }
  | { op: "unwatch"; paneId: string };

export type ServerMessage =
  | { type: "overview"; overview: Overview }
  | { type: "transcript"; paneId: string; page: TranscriptPage };
