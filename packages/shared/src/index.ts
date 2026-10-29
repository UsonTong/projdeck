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
  /** 归档时所在的项目；未归属的会话为 null。 */
  projectId: string | null;
  kind: AgentKind;
  conversationId: string;
  title: string;
  cwd: string;
  archivedAt: string;
}

/** 全局偏好，保存在服务端，所有设备共享。 */
export interface Settings {
  /** IANA 时区名，如 Asia/Shanghai；null 表示跟随各设备自己的时区。 */
  timeZone: string | null;
  /** Claude / Codex 弹出「信任此文件夹」时自动同意（包括在 projdeck 之外启动、或重启后 herdr 恢复的会话）。 */
  autoTrust: boolean;
}

export interface Overview {
  herdr: { online: boolean; error?: string };
  projects: ProjectView[];
  unassigned: Session[];
  archived: ArchivedSession[];
  /** 随总览推送，修改后所有设备实时生效。 */
  settings: Settings;
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

/** 新建时 git 默认为 true：初始化 git 仓库（claude-hud 等工具的 git 信息依赖它）。 */
export type CreateProjectBody = { name: string; git?: boolean } | { path: string; name?: string };
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
  /** 已上传文件（图片或任意文件）的本地绝对路径，追加在消息末尾。 */
  files?: string[];
}
export interface KeysBody {
  keys: string[];
}
export interface UploadResult {
  path: string;
  name: string;
  size: number;
  /** 图片会在消息里显示缩略图，agent 也会当作图片附件处理。 */
  image: boolean;
}

/** 导入项目时浏览文件夹。 */
export interface FolderListing {
  /** 绝对路径；display 为把主目录写成 ~ 的形式。 */
  path: string;
  display: string;
  /** 上一级（已在主目录时为 null）。 */
  parent: string | null;
  dirs: { name: string; path: string; git: boolean }[];
}

// ---- 文件管理器 ----

export interface FileEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: string;
  symlink: boolean;
}

export interface DirListing {
  /** 相对项目根目录的路径，根目录为空字符串。 */
  path: string;
  entries: FileEntry[];
}

// ---- 网页终端外观（读取本机 Ghostty 配置） ----

export interface TerminalTheme {
  /** 来源：本机 Ghostty 配置，或 Ghostty 不可用时的内置默认值。 */
  source: "ghostty" | "default";
  /** Ghostty 配置的字体族；为空时使用 Ghostty 内置的 JetBrains Mono。 */
  fontFamily: string[];
  /** Ghostty 的字号单位是 pt，这里已换算为 CSS px（96 DPI）。 */
  fontSizePx: number;
  background: string;
  foreground: string;
  cursor: string;
  cursorText: string;
  selectionBackground: string;
  selectionForeground: string;
  /** 16 色调色板，索引 0–15。 */
  palette: string[];
  paddingX: number;
  paddingY: number;
}

// ---- WebSocket ----

export type ClientMessage =
  | { op: "watch"; paneId: string }
  | { op: "unwatch"; paneId: string };

export type ServerMessage =
  | { type: "overview"; overview: Overview }
  | { type: "transcript"; paneId: string; page: TranscriptPage }
  /** 本机 Ghostty 配色变了（例如 dankcolors 随壁纸重新生成），前端重新获取主题。 */
  | { type: "theme" };
