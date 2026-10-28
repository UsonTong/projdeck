import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@projdeck/shared";
import { api } from "../api.ts";
import { prepareImage } from "../image.ts";
import { useLive, usePane, useWide } from "../live.ts";
import { openSession } from "../router.ts";
import { Bubbles } from "./Bubbles.tsx";
import { Composer } from "./Composer.tsx";
import type { TerminalHandle } from "./GhosttyTerminal.tsx";
import { KeyBar } from "./KeyBar.tsx";
import { StatusDot } from "./Overview.tsx";
import { useToast } from "./Toast.tsx";

const KIND_LABEL = { claude: "Claude", codex: "Codex", shell: "终端" } as const;

// 终端引擎含 ~400KB 的 WASM，按需加载，总览页打开更快
const GhosttyTerminal = lazy(() => import("./GhosttyTerminal.tsx").then((m) => ({ default: m.GhosttyTerminal })));

type View = "terminal" | "bubbles";

/** 偏好保存在本机：视图模式、字号。 */
function usePref<T extends string | number>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(`projdeck:${key}`);
    if (raw === null) return initial;
    return (typeof initial === "number" ? Number(raw) : raw) as T;
  });
  return [
    value,
    (v: T) => {
      localStorage.setItem(`projdeck:${key}`, String(v));
      setValue(v);
    },
  ];
}

export function SessionPage({ paneId }: { paneId: string }) {
  const { overview } = useLive();
  const wide = useWide();
  const toast = useToast();
  const [preferredView, setPreferredView] = usePref<View>("view", "terminal");
  const [fontSize, setFontSize] = usePref<number>(wide ? "fontSizeWide" : "fontSize", wide ? 14 : 12);
  const [menu, setMenu] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const term = useRef<TerminalHandle>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const found = useMemo(() => {
    if (!overview) return null;
    for (const p of overview.projects) {
      const s = p.sessions.find((x) => x.paneId === paneId);
      if (s) return { session: s, project: p };
    }
    const s = overview.unassigned.find((x) => x.paneId === paneId);
    return s ? { session: s, project: null } : null;
  }, [overview, paneId]);

  useEffect(() => setMenu(false), [paneId]);

  if (!overview) return <div className="loading">加载中…</div>;
  if (!found) {
    return (
      <div className="session gone">
        <p>这个会话已经关闭。</p>
        <button className="primary" onClick={() => openSession(null)}>
          返回总览
        </button>
      </div>
    );
  }

  const { session, project } = found;
  // 临时终端没有对话记录，只有终端视图
  const view: View = session.kind === "shell" ? "terminal" : preferredView;

  const uploadImage = async (file: File): Promise<string | null> => {
    if (!project) {
      toast("未归属项目的会话不能发图，请先导入它所在的文件夹");
      return null;
    }
    try {
      const { blob, name } = await prepareImage(file);
      return (await api.upload(project.id, blob, name)).path;
    } catch (err) {
      toast((err as Error).message);
      return null;
    }
  };

  return (
    <div className="session">
      <header className="session-head">
        {!wide && (
          <button className="ghost icon" onClick={() => openSession(null)} aria-label="返回">
            ←
          </button>
        )}
        <div className="session-title">
          <div className="row-title">
            <StatusDot status={session.status} /> {session.title}
          </div>
          <div className="row-sub">
            {project?.name ?? "未归属"} · {KIND_LABEL[session.kind]}
          </div>
        </div>
        {session.kind !== "shell" && (
          <div className="seg">
            <button className={view === "terminal" ? "on" : ""} onClick={() => setPreferredView("terminal")}>
              终端
            </button>
            <button className={view === "bubbles" ? "on" : ""} onClick={() => setPreferredView("bubbles")}>
              对话
            </button>
          </div>
        )}
        <button className="ghost icon" onClick={() => setMenu(!menu)} aria-label="更多">
          ⋯
        </button>
        {menu && (
          <SessionMenu
            session={session}
            canArchive={!!project}
            fontSize={view === "terminal" ? fontSize : null}
            onFontSize={setFontSize}
            onClose={() => setMenu(false)}
          />
        )}
      </header>

      <div className="session-body">
        {view === "terminal" ? (
          <Suspense fallback={<div className="loading">加载终端…</div>}>
            <GhosttyTerminal
              key={`${paneId}:${fontSize}`}
              ref={term}
              paneId={paneId}
              fontSize={fontSize}
              onImage={uploadImage}
              onCtrlChange={setCtrl}
            />
          </Suspense>
        ) : (
          <BubblesView paneId={paneId} projectId={project?.id ?? null} />
        )}
      </div>

      {view === "bubbles" && session.status === "blocked" && (
        <button className="blocked-banner" onClick={() => setPreferredView("terminal")}>
          需要你处理（权限确认或选项菜单）· 切到终端操作 →
        </button>
      )}

      {view === "terminal" && (
        <KeyBar
          term={term}
          showKeys={!wide}
          ctrl={ctrl}
          composerOpen={composerOpen}
          onToggleComposer={() => setComposerOpen(!composerOpen)}
          onPickImage={() => imageInput.current?.click()}
        />
      )}
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void (async () => {
            for (const f of files) {
              const path = await uploadImage(f);
              if (path) term.current?.paste(`${path} `);
            }
            term.current?.focus();
          })();
        }}
      />

      {(view === "bubbles" || composerOpen) && (
        <Composer paneId={paneId} projectId={project?.id ?? null} kind={session.kind} onSent={() => setComposerOpen(false)} />
      )}
    </div>
  );
}

function BubblesView({ paneId, projectId }: { paneId: string; projectId: string | null }) {
  const pane = usePane(paneId);
  return <Bubbles entries={pane?.transcript ?? []} projectId={projectId} conversationId={pane?.conversationId ?? null} />;
}

function SessionMenu(props: {
  session: Session;
  canArchive: boolean;
  fontSize: number | null;
  onFontSize: (n: number) => void;
  onClose: () => void;
}) {
  const { session, onClose } = props;
  const toast = useToast();
  const [candidates, setCandidates] = useState<{ threadId: string; modifiedAt: string }[] | null>(null);

  const act = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      onClose();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  if (candidates) {
    return (
      <div className="menu session-menu">
        <div className="hint">选择该 Codex 会话对应的对话记录：</div>
        {candidates.length === 0 && <div className="hint">该目录下没有找到最近的 Codex 对话。</div>}
        {candidates.map((c) => (
          <button key={c.threadId} onClick={act(() => api.setCodexConversation(session.paneId, c.threadId))}>
            {new Date(c.modifiedAt).toLocaleString()} · {c.threadId.slice(0, 8)}
            {c.threadId === session.conversationId ? " ✓" : ""}
          </button>
        ))}
        <button onClick={act(() => api.setCodexConversation(session.paneId, null))}>恢复自动匹配</button>
      </div>
    );
  }

  return (
    <div className="menu session-menu">
      {props.fontSize !== null && (
        <div className="menu-row">
          <span>字号 {props.fontSize}</span>
          <button onClick={() => props.onFontSize(Math.max(8, props.fontSize! - 1))}>A−</button>
          <button onClick={() => props.onFontSize(Math.min(24, props.fontSize! + 1))}>A+</button>
        </div>
      )}
      <button onClick={act(() => api.setHidden(session.paneId, !session.hidden))}>{session.hidden ? "取消隐藏" : "隐藏"}</button>
      {session.kind === "codex" && (
        <button onClick={() => void api.codexCandidates(session.paneId).then(setCandidates, (err: Error) => toast(err.message))}>
          选择对话记录
        </button>
      )}
      {session.kind !== "shell" && props.canArchive && (
        <button
          onClick={act(async () => {
            if (session.status === "working" && !confirm("该会话正在工作，归档会立即中断它。确定继续？")) return;
            await api.archive(session.paneId);
            openSession(null);
          })}
        >
          归档（关闭 pane，保留对话）
        </button>
      )}
    </div>
  );
}
