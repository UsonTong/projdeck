import { join } from "node:path";
import type { AgentKind, ArchivedSession, Project } from "@projdeck/shared";
import { configDir, readJson, writeJson } from "../config.ts";

interface State {
  /** terminalId → projectId，归属一旦确定就记住（见 attribution.ts）。 */
  sticky: Record<string, string>;
  /** 隐藏的会话，按 terminalId 与 conversationId 双键记录。 */
  hiddenTerminals: string[];
  hiddenConversations: string[];
  hideUnassigned: boolean;
  /** 手动为 Codex pane 指定的对话：terminalId → threadId。 */
  codexOverrides: Record<string, string>;
}

const defaultArgs: Record<AgentKind, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--yolo"],
};

/** projdeck 自己持有的全部数据：项目登记、归档、隐藏、归属记忆。 */
export class ProjectStore {
  private readonly projectsFile = join(configDir, "projects.json");
  private readonly archiveFile = join(configDir, "archive.json");
  private readonly stateFile = join(configDir, "state.json");

  projects: Project[];
  archive: ArchivedSession[];
  state: State;

  constructor() {
    this.projects = readJson<Project[]>(this.projectsFile, []);
    this.archive = readJson<ArchivedSession[]>(this.archiveFile, []);
    this.state = {
      sticky: {},
      hiddenTerminals: [],
      hiddenConversations: [],
      hideUnassigned: false,
      codexOverrides: {},
      ...readJson<Partial<State>>(this.stateFile, {}),
    };
  }

  saveProjects(): void {
    writeJson(this.projectsFile, this.projects);
  }
  saveArchive(): void {
    writeJson(this.archiveFile, this.archive);
  }
  saveState(): void {
    writeJson(this.stateFile, this.state);
  }

  getProject(id: string): Project {
    const p = this.projects.find((x) => x.id === id);
    if (!p) throw Object.assign(new Error(`项目不存在：${id}`), { statusCode: 404 });
    return p;
  }

  addProject(name: string, path: string): Project {
    if (this.projects.some((p) => p.path === path)) {
      throw Object.assign(new Error(`该文件夹已登记：${path}`), { statusCode: 409 });
    }
    const project: Project = {
      id: this.uniqueId(name),
      name,
      path,
      createdAt: new Date().toISOString(),
      archived: false,
      defaultAgent: "claude",
      agentArgs: structuredClone(defaultArgs),
    };
    this.projects.push(project);
    this.saveProjects();
    return project;
  }

  removeProject(id: string): void {
    this.getProject(id);
    this.projects = this.projects.filter((p) => p.id !== id);
    this.saveProjects();
  }

  private uniqueId(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "") || "project";
    let id = base;
    for (let i = 2; this.projects.some((p) => p.id === id); i++) id = `${base}-${i}`;
    return id;
  }

  /** 合并新的 sticky 归属；有变化才写盘。 */
  updateSticky(next: Record<string, string>): void {
    const changed = Object.entries(next).some(([k, v]) => this.state.sticky[k] !== v);
    if (!changed) return;
    Object.assign(this.state.sticky, next);
    this.saveState();
  }

  /** 清理已不存在的 terminal 的记录，防止 state.json 无限增长。 */
  pruneTerminals(alive: Set<string>): void {
    const before = JSON.stringify(this.state);
    for (const key of Object.keys(this.state.sticky)) if (!alive.has(key)) delete this.state.sticky[key];
    for (const key of Object.keys(this.state.codexOverrides)) if (!alive.has(key)) delete this.state.codexOverrides[key];
    this.state.hiddenTerminals = this.state.hiddenTerminals.filter((t) => alive.has(t));
    if (JSON.stringify(this.state) !== before) this.saveState();
  }

  isHidden(terminalId: string, conversationId: string | null): boolean {
    return (
      this.state.hiddenTerminals.includes(terminalId) ||
      (conversationId !== null && this.state.hiddenConversations.includes(conversationId))
    );
  }

  setHidden(terminalId: string, conversationId: string | null, hidden: boolean): void {
    const without = <T>(xs: T[], x: T) => xs.filter((y) => y !== x);
    this.state.hiddenTerminals = without(this.state.hiddenTerminals, terminalId);
    if (conversationId) this.state.hiddenConversations = without(this.state.hiddenConversations, conversationId);
    if (hidden) {
      this.state.hiddenTerminals.push(terminalId);
      if (conversationId) this.state.hiddenConversations.push(conversationId);
    }
    this.saveState();
  }
}
