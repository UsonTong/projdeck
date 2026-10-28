import { useState } from "react";
import type { ArchivedSession, ProjectView, Session, SessionKind } from "@projdeck/shared";
import { api } from "../api.ts";
import { useLive } from "../live.ts";
import { openSession } from "../router.ts";
import { AddProjectDialog } from "./AddProject.tsx";
import { useToast } from "./Toast.tsx";

const STATUS_LABEL: Record<Session["status"], string> = {
  working: "工作中",
  blocked: "需处理",
  done: "已完成",
  idle: "空闲",
  unknown: "",
};

const KIND_LABEL: Record<SessionKind, string> = { claude: "Claude", codex: "Codex", shell: "终端" };

/** 需要关注的排在前面：需处理 > 工作中 > 已完成 > 其余。 */
const rank = (s: Session) => ({ blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 })[s.status];
const projectRank = (p: ProjectView) => Math.min(5, ...p.sessions.filter((s) => !s.hidden).map(rank));

export function StatusDot({ status }: { status: Session["status"] }) {
  return <span className={`dot ${status}`} title={STATUS_LABEL[status]} />;
}

export function OverviewPage({ activePane }: { activePane: string | null }) {
  const { overview } = useLive();
  const [showHidden, setShowHidden] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);

  if (!overview) return <div className="loading">加载中…</div>;

  const visible = (s: Session) => showHidden || !s.hidden;
  const projects = overview.projects
    .filter((p) => !p.archived)
    .sort((a, b) => projectRank(a) - projectRank(b) || a.name.localeCompare(b.name));
  const archivedProjects = overview.projects.filter((p) => p.archived);
  const hiddenCount = [...overview.projects.flatMap((p) => p.sessions), ...overview.unassigned].filter((s) => s.hidden).length;

  return (
    <div className="overview">
      <header className="topbar">
        <h1>projdeck</h1>
        <div className="actions">
          {hiddenCount > 0 && (
            <button className="ghost small" onClick={() => setShowHidden(!showHidden)}>
              {showHidden ? "收起隐藏" : `已隐藏 ${hiddenCount}`}
            </button>
          )}
          <button className="primary small" onClick={() => setAdding(true)}>
            ＋ 项目
          </button>
        </div>
      </header>

      {projects.length === 0 && (
        <div className="empty">
          还没有项目。点右上角「＋ 项目」新建，或导入已有的文件夹。
        </div>
      )}

      {projects.map((p) => (
        <ProjectCard key={p.id} project={p} sessions={p.sessions.filter(visible)} activePane={activePane} />
      ))}

      <Section title="未归属" count={overview.unassigned.filter(visible).length} hint="不在任何项目文件夹中启动的会话">
        {overview.unassigned.filter(visible).map((s) => (
          <SessionRow key={s.paneId} session={s} projectId={null} active={s.paneId === activePane} />
        ))}
      </Section>

      <Section title="已归档会话" count={overview.archived.length}>
        {overview.archived.map((a) => (
          <ArchivedRow key={a.id} item={a} projectName={overview.projects.find((p) => p.id === a.projectId)?.name} />
        ))}
      </Section>

      {archivedProjects.length > 0 && (
        <Section
          title="已归档项目"
          count={archivedProjects.length}
          open={showArchivedProjects}
          onToggle={() => setShowArchivedProjects(!showArchivedProjects)}
        >
          {archivedProjects.map((p) => (
            <div key={p.id} className="row archived">
              <div className="row-main">
                <div className="row-title">{p.name}</div>
                <div className="row-sub">{p.path}</div>
              </div>
              <button className="ghost small" onClick={() => void api.updateProject(p.id, { archived: false })}>
                恢复
              </button>
            </div>
          ))}
        </Section>
      )}

      {adding && <AddProjectDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function Section(props: {
  title: string;
  count: number;
  hint?: string;
  open?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = props.open ?? localOpen;
  if (props.count === 0) return null;
  return (
    <section className="section">
      <button className="section-head" onClick={props.onToggle ?? (() => setLocalOpen(!open))}>
        <span>{open ? "▾" : "▸"} {props.title}</span>
        <span className="count">{props.count}</span>
      </button>
      {open && (
        <div className="section-body">
          {props.hint && <div className="hint">{props.hint}</div>}
          {props.children}
        </div>
      )}
    </section>
  );
}

function ProjectCard({ project, sessions, activePane }: { project: ProjectView; sessions: Session[]; activePane: string | null }) {
  const [menu, setMenu] = useState(false);
  const toast = useToast();

  const start = async (kind: SessionKind) => {
    setMenu(false);
    try {
      const { paneId } = await api.startSession(project.id, kind);
      openSession(paneId);
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const archiveProject = async () => {
    setMenu(false);
    if (!confirm(`归档项目「${project.name}」？\n项目会从列表收起，herdr 中的会话不受影响。`)) return;
    await api.updateProject(project.id, { archived: true }).catch((err: Error) => toast(err.message));
  };

  const removeProject = async () => {
    setMenu(false);
    if (!confirm(`取消登记「${project.name}」？\n不会删除文件夹，也不会关闭 herdr 中的会话。`)) return;
    await api.removeProject(project.id).catch((err: Error) => toast(err.message));
  };

  const sorted = [...sessions].sort((a, b) => rank(a) - rank(b));

  return (
    <section className="project">
      <header className="project-head">
        <div className="project-name" title={project.path}>
          {project.name}
        </div>
        <div className="project-actions">
          <button className="ghost small" onClick={() => void start(project.defaultAgent)}>
            ＋ {KIND_LABEL[project.defaultAgent]}
          </button>
          <button className="ghost small icon" onClick={() => setMenu(!menu)} aria-label="更多">
            ⋯
          </button>
        </div>
      </header>
      {menu && (
        <div className="menu">
          <button onClick={() => void start("claude")}>新开 Claude</button>
          <button onClick={() => void start("codex")}>新开 Codex</button>
          <button onClick={() => void start("shell")}>新开临时终端</button>
          <hr />
          <button
            onClick={() => {
              setMenu(false);
              void api.updateProject(project.id, { defaultAgent: project.defaultAgent === "claude" ? "codex" : "claude" });
            }}
          >
            默认 agent 改为 {project.defaultAgent === "claude" ? "Codex" : "Claude"}
          </button>
          <button onClick={() => void archiveProject()}>归档项目</button>
          <button className="danger" onClick={() => void removeProject()}>
            取消登记
          </button>
        </div>
      )}
      {sorted.length === 0 ? (
        <div className="row-empty">没有运行中的会话</div>
      ) : (
        sorted.map((s) => <SessionRow key={s.paneId} session={s} projectId={project.id} active={s.paneId === activePane} />)
      )}
    </section>
  );
}

function SessionRow({ session: s, projectId, active }: { session: Session; projectId: string | null; active: boolean }) {
  const [menu, setMenu] = useState(false);
  const toast = useToast();

  const act = (fn: () => Promise<unknown>) => async () => {
    setMenu(false);
    await fn().catch((err: Error) => toast(err.message));
  };

  const archive = act(async () => {
    if (s.status === "working" && !confirm("该会话正在工作，归档会立即中断它。确定继续？")) return;
    await api.archive(s.paneId);
  });

  return (
    <div className={`row ${active ? "active" : ""} ${s.hidden ? "hidden-session" : ""}`}>
      <button className="row-main" onClick={() => openSession(s.paneId)}>
        <StatusDot status={s.status} />
        <span className={`kind ${s.kind}`}>{KIND_LABEL[s.kind]}</span>
        <span className="row-title">{s.title}</span>
        {s.status !== "unknown" && s.status !== "idle" && <span className={`status-text ${s.status}`}>{STATUS_LABEL[s.status]}</span>}
      </button>
      <button className="ghost small icon" onClick={() => setMenu(!menu)} aria-label="会话操作">
        ⋯
      </button>
      {menu && (
        <div className="menu row-menu">
          <button onClick={act(() => api.setHidden(s.paneId, !s.hidden))}>{s.hidden ? "取消隐藏" : "隐藏"}</button>
          {s.kind !== "shell" && projectId && <button onClick={archive}>归档（关闭 pane，保留对话）</button>}
        </div>
      )}
    </div>
  );
}

function ArchivedRow({ item, projectName }: { item: ArchivedSession; projectName?: string }) {
  const toast = useToast();
  const restore = async () => {
    try {
      const { paneId } = await api.restore(item.id);
      openSession(paneId);
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm("删除这条归档记录？对话文件本身不会被删除，仍可在 claude/codex 中手动 resume。")) return;
    await api.deleteArchive(item.id).catch((err: Error) => toast(err.message));
  };
  return (
    <div className="row archived">
      <div className="row-main">
        <span className={`kind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        <div>
          <div className="row-title">{item.title}</div>
          <div className="row-sub">
            {projectName ?? item.projectId} · {new Date(item.archivedAt).toLocaleString()}
          </div>
        </div>
      </div>
      <button className="ghost small" onClick={() => void restore()}>
        恢复
      </button>
      <button className="ghost small icon" onClick={() => void remove()} aria-label="删除归档">
        ✕
      </button>
    </div>
  );
}
