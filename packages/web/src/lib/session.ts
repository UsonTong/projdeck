import type { Session, SessionKind } from "@projdeck/shared";

export const KIND_LABEL: Record<SessionKind, string> = { claude: "Claude", codex: "Codex", shell: "终端" };

export const STATUS_LABEL: Record<Session["status"], string> = {
  working: "工作中",
  blocked: "需处理",
  done: "已完成",
  idle: "空闲",
  unknown: "",
};

/**
 * 刚从 projdeck 新开的临时终端。网页连上时 pane 尺寸会变，zsh（尤其 Powerlevel10k 两行提示符）
 * 在会重排的终端里重画提示符会留下一份旧的；新终端里没有内容，连上后清一次屏即可。
 */
const freshShells = new Set<string>();
export const markFreshShell = (paneId: string) => freshShells.add(paneId);
export const takeFreshShell = (paneId: string) => freshShells.delete(paneId);

/** 需要关注的排在前面：需处理 > 工作中 > 已完成 > 其余。 */
export const statusRank = (s: Session) => ({ blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 })[s.status];
