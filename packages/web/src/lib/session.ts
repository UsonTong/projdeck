import type { AgentKind, Session, SessionKind } from "@projdeck/shared";

/** 能新开的 agent，按默认顺序。 */
export const AGENT_KINDS: AgentKind[] = ["claude", "codex", "pi", "harness"];

export const KIND_LABEL: Record<SessionKind, string> = { claude: "Claude", codex: "Codex", pi: "Pi", harness: "DeepSeek", shell: "终端" };

export const STATUS_LABEL: Record<Session["status"], string> = {
  working: "工作中",
  blocked: "需处理",
  done: "已完成",
  idle: "空闲",
  unknown: "",
};

/**
 * 刚从 projdeck 启动 agent 的 pane。herdr 识别出 agent 之前它看起来还是普通终端，
 * 会话页要等识别出来再按偏好选视图（否则总是停在终端视图）。
 */
const launching = new Set<string>();
export const markLaunching = (paneId: string) => launching.add(paneId);
export const isLaunching = (paneId: string) => launching.has(paneId);
export const doneLaunching = (paneId: string) => launching.delete(paneId);

/** 需要关注的排在前面：需处理 > 工作中 > 已完成 > 其余。 */
export const statusRank = (s: Session) => ({ blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 })[s.status];
