// projdeck 前后端共享的 API 契约。只放类型，运行时为空。

export type AgentKind = "claude" | "codex" | "pi";
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
  /** 是否推送这个项目里会话的完成 / 需处理通知（未设置视为开启）。 */
  notify?: boolean;
  /** 备注：只在项目列表里醒目地显示，方便认出项目，不影响别的地方。 */
  note?: string;
  /** 「自定义」排序下的位置（拖动调整），越小越靠前。 */
  order?: number;
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
  /** 在 herdr 侧栏里的位置（工作区顺序，同一工作区内按 pane 顺序），越小越靠前。 */
  order: number;
  /** 最后活动时间（对话记录最后修改的时间，毫秒）；临时终端或没有对话时为 null。 */
  activeAt: number | null;
  /** 用户起过名字（title 就是这个名字，不再跟随 Claude / Codex 自动生成的标题）。 */
  renamed?: boolean;
  /** herdr 重启后没能恢复（启动目录已不存在等），终端没有运行。 */
  restoreError?: string;
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
  notify?: boolean;
  /** 空字符串清除备注。 */
  note?: string;
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

/** CC Switch 里一个应用（Claude Code、Codex……）的供应商。不含任何配置和密钥。 */
export interface CcSwitchApp {
  /** CC Switch 的 app_type，例如 claude、codex。 */
  app: string;
  label: string;
  providers: { id: string; name: string; website: string | null; category: string | null; current: boolean }[];
}

/** CC Switch（AI 编程工具的供应商管理器）的状态。 */
export interface CcSwitchStatus {
  installed: boolean;
  /** 桌面上的 CC Switch 正在运行（切换经由它的托盘菜单完成）。 */
  running: boolean;
  apps: CcSwitchApp[];
}

export type CcUsageRange = "today" | "7d" | "30d" | "all";

/** 按模型或供应商汇总的一行用量。 */
export interface CcUsageRow {
  name: string;
  app: string;
  requests: number;
  cost: number;
  tokens: number;
  successRate: number;
  /** 输出速度（token/秒）；没有可用数据时为 null。 */
  speed: number | null;
  /** 速度是由会话日志估算的（含首字等待），不是经代理精确计时的。 */
  speedEstimated: boolean;
  /** 首字时间中位数（毫秒）。 */
  firstTokenMs: number | null;
  firstTokenEstimated: boolean;
}

/** CC Switch 的用量统计（只读，与它的「用量」页同口径）。 */
export interface CcUsage {
  range: CcUsageRange;
  /** 只看某个应用；null 表示全部。 */
  app: string | null;
  /** 有记录的应用（筛选用）。 */
  apps: { app: string; label: string }[];
  summary: { cost: number; requests: number; tokens: number; cacheHitRate: number; todayCost: number };
  /** 趋势：今天按小时，其他按天。 */
  series: { label: string; requests: number; cost: number; tokens: number }[];
  models: CcUsageRow[];
  providers: CcUsageRow[];
  /** 最近的请求（最多 100 条）。 */
  logs: {
    at: number;
    app: string;
    provider: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    cost: number;
    status: number;
    latencyMs: number;
  }[];
}

/** 连进 projdeck 的设备（目前是通过远程 adb 中继连上来的安卓手机）。 */
export interface DeviceView {
  id: string;
  kind: "android";
  /** 品牌 + 型号 */
  name: string;
  model: string;
  brand: string;
  /** 例如 "Android 11" */
  os: string;
  online: boolean;
  /** 本次连上的时间（毫秒时间戳），不在线时为 null */
  since: number | null;
  /** 最后一次有消息的时间；在线时就是现在 */
  lastSeen: number;
  battery: number | null;
  charging: boolean | null;
  network: "wifi" | "mobile" | "none" | null;
  vpn: boolean | null;
  /** 手机上 adb 的 TCP 模式（5555）是否在监听 */
  tcpMode: boolean | null;
  appVersion: string | null;
  /** 电脑上连接这台手机的 adb 命令；不在线时为 null */
  adb: { command: string; connections: number } | null;
}
