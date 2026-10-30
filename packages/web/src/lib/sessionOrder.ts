import type { Overview, ProjectView, Session } from "@projdeck/shared";
import { useDevicePref } from "@/lib/devicePrefs";
import { statusRank } from "@/lib/session";

/**
 * 侧栏里会话的顺序。总览列表和会话页左右滑切换会话共用，保证滑到的「下一个」就是列表里的下一个。
 */

export type UnassignedSort = "herdr" | "recent" | "status";

export const UNASSIGNED_SORTS: { value: UnassignedSort; label: string; hint: string }[] = [
  { value: "herdr", label: "herdr 顺序", hint: "与电脑上 herdr 侧栏一致，可拖动调整" },
  { value: "recent", label: "最近活动", hint: "最近有新消息的排在前面" },
  { value: "status", label: "状态", hint: "需处理 > 工作中 > 已完成 > 空闲" },
];

export const useUnassignedSort = () => useDevicePref<UnassignedSort>("unassignedSort", "herdr");

/** 项目：有需要关注的会话的项目排在前面，再按名称。 */
const projectRank = (p: ProjectView) => Math.min(5, ...p.sessions.filter((s) => !s.hidden).map(statusRank));
export const sortProjects = (projects: ProjectView[]) =>
  projects.filter((p) => !p.archived).sort((a, b) => projectRank(a) - projectRank(b) || a.name.localeCompare(b.name));

/** 项目内的会话：需要关注的排在前面。 */
export const sortProjectSessions = (sessions: Session[]) => [...sessions].sort((a, b) => statusRank(a) - statusRank(b) || a.order - b.order);

export function sortUnassigned(list: Session[], mode: UnassignedSort): Session[] {
  const byOrder = (a: Session, b: Session) => a.order - b.order;
  if (mode === "recent") return [...list].sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0) || byOrder(a, b));
  if (mode === "status") return [...list].sort((a, b) => statusRank(a) - statusRank(b) || byOrder(a, b));
  return [...list].sort(byOrder);
}

/** 列表里从上到下的全部会话（不含隐藏的）：先各项目，再未归属。 */
export function navigationOrder(overview: Overview, unassignedSort: UnassignedSort): Session[] {
  return [
    ...sortProjects(overview.projects).flatMap((p) => sortProjectSessions(p.sessions.filter((s) => !s.hidden))),
    ...sortUnassigned(
      overview.unassigned.filter((s) => !s.hidden),
      unassignedSort,
    ),
  ];
}
