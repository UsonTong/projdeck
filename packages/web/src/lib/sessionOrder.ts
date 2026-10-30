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

export type ProjectSort = "custom" | "recent" | "status";

export const PROJECT_SORTS: { value: ProjectSort; label: string; hint: string }[] = [
  { value: "custom", label: "自定义", hint: "按住项目标题拖动调整顺序" },
  { value: "recent", label: "最近活动", hint: "最近有新消息的项目和会话排在前面" },
  { value: "status", label: "状态", hint: "有需处理 / 工作中会话的项目排在前面" },
];

export const useProjectSort = () => useDevicePref<ProjectSort>("projectSort", "status");

const byName = (a: ProjectView, b: ProjectView) => a.name.localeCompare(b.name);
/** 项目里最需要关注的会话的状态。 */
const projectRank = (p: ProjectView) => Math.min(5, ...p.sessions.filter((s) => !s.hidden).map(statusRank));
/** 项目里最近一次活动的时间。 */
const projectActiveAt = (p: ProjectView) => Math.max(0, ...p.sessions.filter((s) => !s.hidden).map((s) => s.activeAt ?? 0));

export function sortProjects(projects: ProjectView[], mode: ProjectSort): ProjectView[] {
  const list = projects.filter((p) => !p.archived);
  if (mode === "custom") return list.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || byName(a, b));
  if (mode === "recent") return list.sort((a, b) => projectActiveAt(b) - projectActiveAt(a) || byName(a, b));
  return list.sort((a, b) => projectRank(a) - projectRank(b) || byName(a, b));
}

/** 项目内的会话：按状态时需要关注的排在前面，按最近活动时新的在前，自定义时与 herdr 一致。 */
export function sortProjectSessions(sessions: Session[], mode: ProjectSort): Session[] {
  const byOrder = (a: Session, b: Session) => a.order - b.order;
  if (mode === "recent") return [...sessions].sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0) || byOrder(a, b));
  if (mode === "custom") return [...sessions].sort(byOrder);
  return [...sessions].sort((a, b) => statusRank(a) - statusRank(b) || byOrder(a, b));
}

export function sortUnassigned(list: Session[], mode: UnassignedSort): Session[] {
  const byOrder = (a: Session, b: Session) => a.order - b.order;
  if (mode === "recent") return [...list].sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0) || byOrder(a, b));
  if (mode === "status") return [...list].sort((a, b) => statusRank(a) - statusRank(b) || byOrder(a, b));
  return [...list].sort(byOrder);
}

/** 列表里从上到下的全部会话（不含隐藏的）：先各项目，再未归属。 */
export function navigationOrder(overview: Overview, projectSort: ProjectSort, unassignedSort: UnassignedSort): Session[] {
  return [
    ...sortProjects(overview.projects, projectSort).flatMap((p) => sortProjectSessions(p.sessions.filter((s) => !s.hidden), projectSort)),
    ...sortUnassigned(
      overview.unassigned.filter((s) => !s.hidden),
      unassignedSort,
    ),
  ];
}
