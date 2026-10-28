import { sep } from "node:path";

export interface PaneLocation {
  terminalId: string;
  workspaceId: string;
  cwd: string;
}

export interface ProjectLocation {
  id: string;
  path: string;
}

/** dir 是否等于 root 或位于 root 之下（按路径段比较，/a/bc 不属于 /a/b）。 */
export function isWithin(dir: string, root: string): boolean {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root;
  return dir === r || dir.startsWith(r + sep);
}

/** 最长前缀匹配：嵌套项目时，越具体的项目优先。 */
export function matchProject(cwd: string, projects: ProjectLocation[]): string | null {
  let best: ProjectLocation | null = null;
  for (const p of projects) {
    if (isWithin(cwd, p.path) && (!best || p.path.length > best.path.length)) best = p;
  }
  return best?.id ?? null;
}

/**
 * 推导每个 pane 所属的项目。
 *
 * herdr 的 pane cwd 会跟随 shell 的 cd 变化，所以单看当前 cwd 不可靠，按以下顺序判断：
 * 1. sticky：此前已归属过的 terminal 保持原项目（只要项目还在登记中）；
 * 2. 当前 cwd 的最长前缀匹配；
 * 3. 同一 workspace 中其他 pane 已归属的项目（临时终端 cd 出去后仍留在项目里）。
 *
 * 返回 terminalId → projectId（未归属为 null），以及应写回 sticky 的新归属。
 */
export function attribute(
  panes: PaneLocation[],
  projects: ProjectLocation[],
  sticky: Record<string, string>,
): { assignments: Map<string, string | null>; newSticky: Record<string, string> } {
  const known = new Set(projects.map((p) => p.id));
  const assignments = new Map<string, string | null>();
  const newSticky: Record<string, string> = {};

  for (const pane of panes) {
    const remembered = sticky[pane.terminalId];
    const id = remembered && known.has(remembered) ? remembered : matchProject(pane.cwd, projects);
    assignments.set(pane.terminalId, id);
    if (id) newSticky[pane.terminalId] = id;
  }

  // workspace 内只有一个项目时，把未归属的 pane 也归入该项目
  const byWorkspace = new Map<string, Set<string>>();
  for (const pane of panes) {
    const id = assignments.get(pane.terminalId);
    if (!id) continue;
    let set = byWorkspace.get(pane.workspaceId);
    if (!set) byWorkspace.set(pane.workspaceId, (set = new Set()));
    set.add(id);
  }
  for (const pane of panes) {
    if (assignments.get(pane.terminalId)) continue;
    const ids = byWorkspace.get(pane.workspaceId);
    if (ids?.size === 1) {
      const [id] = ids;
      assignments.set(pane.terminalId, id!);
      newSticky[pane.terminalId] = id!;
    }
  }

  return { assignments, newSticky };
}
