import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type {
  AgentKind,
  ArchivedSession,
  Overview,
  Project,
  ProjectSuggestion,
  ProjectView,
  Session,
  SessionKind,
  Settings,
  TranscriptPage,
} from "@projdeck/shared";
import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr/client.ts";
import type { HerdrAgent, HerdrPane } from "./herdr/types.ts";
import { attribute, isWithin } from "./projects/attribution.ts";
import type { ProjectStore } from "./projects/store.ts";
import { findClaudeTranscript, parseClaudeRecords } from "./transcript/claude.ts";
import { listCodexRollouts, matchCodexRollouts, parseCodexRecords, type CodexRollout } from "./transcript/codex.ts";
import { readJsonl } from "./transcript/jsonl.ts";
import { acceptTrustPrompt } from "./trust.ts";

export function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** 前端快捷键条允许发送的按键。 */
const ALLOWED_KEYS = new Set([
  "esc", "enter", "up", "down", "left", "right", "tab", "shift+tab", "backspace", "space",
  "ctrl+c", "ctrl+d", "ctrl+l", "ctrl+r", "1", "2", "3", "4", "5", "6", "7", "8", "9", "y", "n",
]);

/** 终端标题前缀的状态符号（✳ ◐ ⠹ 等），显示时去掉。 */
function cleanTitle(title: string | undefined): string {
  return (title ?? "").replace(/^[^\p{L}\p{N}~/.]+/u, "").trim();
}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

interface Snapshot {
  at: number;
  overview: Overview;
  sessions: Map<string, { session: Session; projectId: string | null; rollout?: CodexRollout }>;
}

export class ProjdeckService {
  private readonly config: Config;
  private readonly herdr: HerdrClient;
  private readonly store: ProjectStore;
  private snapshot: Snapshot | undefined;
  private codexCache: { at: number; rollouts: CodexRollout[] } | undefined;

  constructor(config: Config, herdr: HerdrClient, store: ProjectStore) {
    this.config = config;
    this.herdr = herdr;
    this.store = store;
  }

  // ---- 总览 ----

  private async codexRollouts(): Promise<CodexRollout[]> {
    if (!this.codexCache || Date.now() - this.codexCache.at > 5_000) {
      this.codexCache = { at: Date.now(), rollouts: await listCodexRollouts() };
    }
    return this.codexCache.rollouts;
  }

  async overview(): Promise<Overview> {
    return (await this.refresh()).overview;
  }

  /** 从 herdr 现场推导总览。projdeck 不缓存任何运行时状态，每次都重新计算。 */
  async refresh(): Promise<Snapshot> {
    const projects = this.store.projects;
    const views: ProjectView[] = projects.map((p) => ({ ...p, sessions: [] }));
    const viewById = new Map(views.map((v) => [v.id, v]));
    const sessions: Snapshot["sessions"] = new Map();
    const overview: Overview = {
      herdr: { online: true },
      projects: views,
      unassigned: [],
      archived: this.store.archive,
      settings: this.store.settings,
    };

    let panes: HerdrPane[];
    let agents: HerdrAgent[];
    try {
      [panes, agents] = await Promise.all([this.herdr.listPanes(), this.herdr.listAgents()]);
    } catch (err) {
      overview.herdr = { online: false, error: (err as Error).message };
      this.snapshot = { at: Date.now(), overview, sessions };
      return this.snapshot;
    }

    const agentByPane = new Map(agents.map((a) => [a.pane_id, a]));
    const { assignments, newSticky } = attribute(
      panes.map((p) => ({ terminalId: p.terminal_id, workspaceId: p.workspace_id, cwd: p.cwd })),
      projects,
      this.store.state.sticky,
    );
    this.store.updateSticky(newSticky);
    this.store.pruneTerminals(new Set(panes.map((p) => p.terminal_id)));

    const codexPanes = agents.filter((a) => a.agent === "codex");
    const codexMatches = codexPanes.length
      ? matchCodexRollouts(
          codexPanes.filter((a) => !this.store.state.codexOverrides[a.terminal_id]).map((a) => ({ terminalId: a.terminal_id, cwd: a.cwd })),
          await this.codexRollouts(),
        )
      : new Map<string, CodexRollout>();

    for (const pane of panes) {
      const agent = agentByPane.get(pane.pane_id);
      const kind: SessionKind = agent?.agent === "claude" || agent?.agent === "codex" ? agent.agent : "shell";
      let conversationId: string | null = null;
      let rollout: CodexRollout | undefined;
      if (kind === "claude") conversationId = agent?.agent_session?.value ?? null;
      if (kind === "codex") {
        const override = this.store.state.codexOverrides[pane.terminal_id];
        rollout = override ? (await this.codexRollouts()).find((r) => r.threadId === override) : codexMatches.get(pane.terminal_id);
        conversationId = override ?? rollout?.threadId ?? null;
      }
      const session: Session = {
        paneId: pane.pane_id,
        terminalId: pane.terminal_id,
        workspaceId: pane.workspace_id,
        kind,
        status: kind === "shell" ? "unknown" : (agent?.agent_status ?? pane.agent_status),
        title: cleanTitle(agent?.terminal_title_stripped ?? pane.terminal_title_stripped) || basename(pane.cwd),
        cwd: pane.cwd,
        conversationId,
        hidden: this.store.isHidden(pane.terminal_id, conversationId),
      };
      const projectId = assignments.get(pane.terminal_id) ?? null;
      sessions.set(pane.pane_id, { session, projectId, rollout });
      const view = projectId ? viewById.get(projectId) : undefined;
      if (view) view.sessions.push(session);
      else overview.unassigned.push(session);
    }

    this.snapshot = { at: Date.now(), overview, sessions };
    return this.snapshot;
  }

  private async lookup(paneId: string) {
    const snap = this.snapshot && Date.now() - this.snapshot.at < 2_000 ? this.snapshot : await this.refresh();
    const entry = snap.sessions.get(paneId) ?? (await this.refresh()).sessions.get(paneId);
    if (!entry) throw httpError(404, `会话不存在：${paneId}`);
    return entry;
  }

  // ---- 设置 ----

  updateSettings(patch: Partial<Settings>): Settings {
    if (patch.timeZone !== undefined) {
      if (patch.timeZone !== null) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: patch.timeZone });
        } catch {
          throw httpError(400, `无效的时区：${patch.timeZone}`);
        }
      }
      this.store.settings.timeZone = patch.timeZone;
    }
    this.store.saveSettings();
    this.snapshot = undefined;
    return this.store.settings;
  }

  // ---- 项目 ----

  /** 文件管理器使用的项目根目录。 */
  projectPath(id: string): string {
    return this.store.getProject(id).path;
  }

  createProject(name: string, git = true): Project {
    if (!/^[\w.\-\p{L}\p{N} ]+$/u.test(name) || name.startsWith(".")) throw httpError(400, "项目名只能包含字母、数字、中文、空格和 - _ .");
    const path = join(expandHome(this.config.projectsRoot), name);
    try {
      statSync(path);
      throw httpError(409, `文件夹已存在：${path}，请使用导入`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    mkdirSync(path, { recursive: true });
    if (git) {
      // 失败（比如没装 git）不影响建项目
      try {
        execFileSync("git", ["init", "-q"], { cwd: path, timeout: 10_000, stdio: "ignore" });
      } catch {
        // 忽略
      }
    }
    return this.store.addProject(name, path);
  }

  importProject(rawPath: string, name?: string): Project {
    const expanded = expandHome(rawPath.trim());
    if (!isAbsolute(expanded)) throw httpError(400, "请输入绝对路径或 ~/ 开头的路径");
    let path: string;
    try {
      path = realpathSync(resolve(expanded));
      if (!statSync(path).isDirectory()) throw new Error();
    } catch {
      throw httpError(400, `文件夹不存在：${expanded}`);
    }
    if (path === homedir() || path === "/") throw httpError(400, "不能把整个主目录登记为项目");
    return this.store.addProject(name?.trim() || basename(path), path);
  }

  updateProject(id: string, patch: { name?: string; archived?: boolean; defaultAgent?: AgentKind }): Project {
    const p = this.store.getProject(id);
    if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
    if (patch.archived !== undefined) p.archived = patch.archived;
    if (patch.defaultAgent !== undefined) p.defaultAgent = patch.defaultAgent;
    this.store.saveProjects();
    return p;
  }

  removeProject(id: string): void {
    this.store.removeProject(id);
  }

  /** 从 herdr 现有会话的目录推测可导入的项目。 */
  async suggestions(): Promise<ProjectSuggestion[]> {
    const snap = await this.refresh();
    const counts = new Map<string, number>();
    for (const s of snap.overview.unassigned) {
      if (s.kind === "shell" || s.cwd === homedir() || s.cwd === "/") continue;
      counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
    }
    return [...counts]
      .map(([path, sessionCount]) => ({ path, name: basename(path), sessionCount }))
      .sort((a, b) => b.sessionCount - a.sessionCount);
  }

  // ---- 会话 ----

  /** 在项目所在的 herdr workspace 中新开一个 tab；没有则新建 workspace。返回新 pane。 */
  private async openPane(project: Project): Promise<string> {
    const snap = await this.refresh();
    const view = snap.overview.projects.find((p) => p.id === project.id);
    const workspaceId = view?.sessions[0]?.workspaceId;
    if (workspaceId) return (await this.herdr.createTab(workspaceId, project.path)).paneId;
    return (await this.herdr.createWorkspace(project.path, project.name)).paneId;
  }

  private async launchAgent(paneId: string, project: Project, kind: AgentKind, extraArgs: string[]): Promise<void> {
    const name = `${project.id}-${kind}-${Date.now().toString(36).slice(-4)}`;
    await this.herdr.startAgent(paneId, kind, name, [...extraArgs, ...project.agentArgs[kind]]);
    // 项目目录是用户主动新建或导入的，自动通过「信任此文件夹」确认；后台进行，不阻塞请求
    void acceptTrustPrompt(this.herdr, paneId).catch(() => {});
  }

  /** 网页终端 attach 的目标。 */
  async terminalIdOf(paneId: string): Promise<string> {
    return (await this.lookup(paneId)).session.terminalId;
  }

  async startSession(projectId: string, kind: SessionKind): Promise<{ paneId: string }> {
    const project = this.store.getProject(projectId);
    const paneId = await this.openPane(project);
    if (kind !== "shell") await this.launchAgent(paneId, project, kind, []);
    this.snapshot = undefined;
    return { paneId };
  }

  async output(paneId: string, lines?: number): Promise<string> {
    await this.lookup(paneId);
    return this.herdr.readPane(paneId, lines);
  }

  async prompt(paneId: string, text: string, files: string[] = []): Promise<void> {
    const { session } = await this.lookup(paneId);
    for (const f of files) if (!isAbsolute(f)) throw httpError(400, `文件路径无效：${f}`);
    const full = [text.trim(), files.join(" ")].filter(Boolean).join("\n\n");
    if (!full) throw httpError(400, "消息为空");
    if (session.kind === "shell") await this.herdr.sendInput(paneId, full, ["enter"]);
    else await this.herdr.prompt(paneId, full);
  }

  async keys(paneId: string, keys: string[]): Promise<void> {
    await this.lookup(paneId);
    const bad = keys.find((k) => !ALLOWED_KEYS.has(k));
    if (bad || keys.length === 0 || keys.length > 16) throw httpError(400, `不支持的按键：${bad ?? "(空)"}`);
    await this.herdr.sendKeys(paneId, keys);
  }

  async setHidden(paneId: string, hidden: boolean): Promise<void> {
    const { session } = await this.lookup(paneId);
    this.store.setHidden(session.terminalId, session.conversationId, hidden);
    this.snapshot = undefined;
  }

  async setCodexConversation(paneId: string, threadId: string | null): Promise<void> {
    const { session } = await this.lookup(paneId);
    if (session.kind !== "codex") throw httpError(400, "只有 Codex 会话需要手动选择对话");
    if (threadId) this.store.state.codexOverrides[session.terminalId] = threadId;
    else delete this.store.state.codexOverrides[session.terminalId];
    this.store.saveState();
    this.snapshot = undefined;
  }

  /** 列出与会话同目录的 Codex 对话，供手动选择。 */
  async codexCandidates(paneId: string): Promise<{ threadId: string; modifiedAt: string }[]> {
    const { session } = await this.lookup(paneId);
    return (await listCodexRollouts())
      .filter((r) => r.cwd === session.cwd)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 20)
      .map((r) => ({ threadId: r.threadId, modifiedAt: new Date(r.mtimeMs).toISOString() }));
  }

  // ---- 归档 ----

  async archive(paneId: string): Promise<ArchivedSession> {
    const { session, projectId } = await this.lookup(paneId);
    if (session.kind === "shell") throw httpError(400, "临时终端没有对话可归档，请直接关闭");
    if (!session.conversationId) throw httpError(409, "找不到该会话的对话 ID，无法归档后恢复");
    if (!projectId) throw httpError(409, "未归属项目的会话请先导入项目再归档");
    const item: ArchivedSession = {
      id: `${Date.now().toString(36)}-${session.conversationId.slice(0, 8)}`,
      projectId,
      kind: session.kind,
      conversationId: session.conversationId,
      title: session.title,
      cwd: session.cwd,
      archivedAt: new Date().toISOString(),
    };
    this.store.archive.unshift(item);
    this.store.saveArchive();
    await this.herdr.closePane(paneId);
    this.snapshot = undefined;
    return item;
  }

  async restore(archiveId: string): Promise<{ paneId: string }> {
    const item = this.store.archive.find((a) => a.id === archiveId);
    if (!item) throw httpError(404, "归档记录不存在");
    const project = this.store.getProject(item.projectId);
    const paneId = await this.openPane(project);
    const resumeArgs = item.kind === "claude" ? ["--resume", item.conversationId] : ["resume", item.conversationId];
    await this.launchAgent(paneId, project, item.kind, resumeArgs);
    this.store.archive = this.store.archive.filter((a) => a.id !== archiveId);
    this.store.saveArchive();
    this.snapshot = undefined;
    return { paneId };
  }

  deleteArchive(archiveId: string): void {
    this.store.archive = this.store.archive.filter((a) => a.id !== archiveId);
    this.store.saveArchive();
  }

  // ---- 会话记录 ----

  async transcript(paneId: string, cursor: number): Promise<TranscriptPage> {
    const { session, rollout } = await this.lookup(paneId);
    const empty: TranscriptPage = { conversationId: null, entries: [], cursor: -1, reset: false };
    if (!session.conversationId) return empty;

    let file: string | null = null;
    if (session.kind === "claude") file = findClaudeTranscript(session.cwd, session.conversationId);
    if (session.kind === "codex") file = rollout?.file ?? null;
    if (!file) return { ...empty, conversationId: session.conversationId };

    const chunk = await readJsonl(file, cursor);
    const entries =
      session.kind === "claude" ? parseClaudeRecords(chunk.records) : parseCodexRecords(chunk.records, chunk.cursor);
    return { conversationId: session.conversationId, entries, cursor: chunk.cursor, reset: chunk.reset };
  }

  projectFor(paneId: string): Promise<string | null> {
    return this.lookup(paneId).then((e) => e.projectId);
  }

  /**
   * 项目是否包含某路径（上传文件访问校验用）。
   * 先解析 .. 和符号链接再比较，防止 `项目/../别处` 或项目内软链接绕过检查。
   */
  projectContains(projectId: string, path: string): boolean {
    try {
      return isWithin(realpathSync(resolve(path)), realpathSync(this.store.getProject(projectId).path));
    } catch {
      return false;
    }
  }
}
