import type { Session, SessionKind } from "@projdeck/shared";

export const KIND_LABEL: Record<SessionKind, string> = { claude: "Claude", codex: "Codex", shell: "终端" };

export const STATUS_LABEL: Record<Session["status"], string> = {
  working: "工作中",
  blocked: "需处理",
  done: "已完成",
  idle: "空闲",
  unknown: "",
};

/** 需要关注的排在前面：需处理 > 工作中 > 已完成 > 其余。 */
export const statusRank = (s: Session) => ({ blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 })[s.status];
