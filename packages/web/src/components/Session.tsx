import type { Session } from "@projdeck/shared";
import { ArrowLeftIcon, FolderOpenIcon, MessagesSquareIcon, SquareTerminalIcon, TriangleAlertIcon } from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { doneLaunching, isLaunching, STATUS_LABEL } from "@/lib/session";
import { themeKey, useTerminalTheme } from "@/lib/terminalTheme";
import { uploadFile } from "@/lib/upload";
import { api } from "../api.ts";
import { useLive, usePane, useWide } from "../live.ts";
import { openSession } from "../router.ts";
import { Bubbles } from "./Bubbles.tsx";
import { Composer } from "./Composer.tsx";
import { FileBrowser } from "./FileBrowser.tsx";
import type { TerminalHandle } from "./GhosttyTerminal.tsx";
import { KeyBar } from "./KeyBar.tsx";
import { AgentIcon } from "./AgentIcon.tsx";
import { SessionActions } from "./SessionActions.tsx";

// 终端引擎含 ~400KB 的 WASM，按需加载，总览页打开更快
const GhosttyTerminal = lazy(() => import("./GhosttyTerminal.tsx").then((m) => ({ default: m.GhosttyTerminal })));

type View = "terminal" | "bubbles" | "files";

const fail = (err: unknown) => toast.error((err as Error).message);

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

const Loading = ({ label }: { label?: string }) => (
  <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
    <Spinner />
    {label}
  </div>
);

export function SessionPage({ paneId }: { paneId: string }) {
  const { overview } = useLive();
  const wide = useWide();
  const [preferredView, setPreferredView] = usePref<View>("view", "terminal");
  const theme = useTerminalTheme();
  // 0 表示未手动调整：电脑上跟随 Ghostty 的字号，手机上用 12px
  const [fontSizePref, setFontSize] = usePref<number>(wide ? "termFontSizeWide" : "termFontSize", 0);
  const defaultFontSize = wide ? (theme?.fontSizePx ?? 16) : 12;
  const fontSize = fontSizePref || defaultFontSize;
  const changeFontSize = (delta: 1 | -1 | 0) =>
    setFontSize(delta === 0 ? 0 : Math.min(28, Math.max(8, fontSize + delta)));
  // 电脑上沿用 Ghostty 的 window-padding；手机屏幕窄，只留一点边距
  const padding = wide && theme ? { x: theme.paddingX, y: theme.paddingY } : { x: 4, y: 4 };
  // 这一页的视图在打开时定下来。之后会话类型变了（在终端里输入 claude，临时终端变成 Claude 会话）也不自动切走
  const [chosenView, setChosenView] = useState<View | null>(null);
  const openedView = useRef<View | null>(null);
  const chooseView = (v: View) => {
    setChosenView(v);
    setPreferredView(v);
  };
  const [composerOpen, setComposerOpen] = useState(false);
  const [filesPath, setFilesPath] = useState<string | null>(null);
  const [ctrl, setCtrl] = useState(false);
  const term = useRef<TerminalHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const found = useMemo(() => {
    if (!overview) return null;
    for (const p of overview.projects) {
      const s = p.sessions.find((x) => x.paneId === paneId);
      if (s) return { session: s, project: p };
    }
    const s = overview.unassigned.find((x) => x.paneId === paneId);
    return s ? { session: s, project: null } : null;
  }, [overview, paneId]);

  if (!overview) return <Loading />;
  if (!found) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>这个会话已经关闭</EmptyTitle>
          <EmptyDescription>它可能被归档，或在电脑上被关掉了。</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => openSession(null)}>返回总览</Button>
        </EmptyContent>
      </Empty>
    );
  }

  const { session, project } = found;
  // 临时终端没有对话视图；不属于项目的会话没有文件视图
  let view: View = chosenView ?? openedView.current ?? preferredView;
  if (view === "bubbles" && session.kind === "shell") view = "terminal";
  if (view === "files" && !project) view = "terminal";
  if (session.kind !== "shell") doneLaunching(paneId);
  if (!isLaunching(paneId)) openedView.current ??= view;
  // 文件视图默认打开会话的工作目录（在项目内时）
  const cwdInProject = project && (session.cwd + "/").startsWith(project.path + "/") ? session.cwd.slice(project.path.length + 1) : "";

  const upload = async (file: File): Promise<string | null> => {
    if (!project) {
      toast.error("未归属项目的会话不能上传文件，请先导入它所在的文件夹");
      return null;
    }
    const id = toast.loading(`正在上传 ${file.name}`);
    try {
      const { path } = await uploadFile(project.id, file);
      toast.success(`已上传 ${file.name}`, { id });
      return path;
    } catch (err) {
      toast.error((err as Error).message, { id });
      return null;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-1.5 border-b px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
        {!wide && (
          <Button variant="ghost" size="icon" aria-label="返回" onClick={() => openSession(null)}>
            <ArrowLeftIcon />
          </Button>
        )}
        <AgentIcon kind={session.kind} status={session.status} className={wide ? "ml-1" : undefined} />
        <div className="min-w-0 flex-1 pl-1">
          <div className="truncate text-sm font-medium">{session.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {project?.name ?? "未归属"}
            {STATUS_LABEL[session.status] && session.status !== "idle" && ` · ${STATUS_LABEL[session.status]}`}
          </div>
        </div>
        {(session.kind !== "shell" || project) && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={view}
            onValueChange={(v) => v && chooseView(v as View)}
            aria-label="视图"
          >
            <ToggleGroupItem value="terminal" aria-label="终端">
              <SquareTerminalIcon />
              <span className="max-sm:sr-only">终端</span>
            </ToggleGroupItem>
            {session.kind !== "shell" && (
              <ToggleGroupItem value="bubbles" aria-label="对话">
                <MessagesSquareIcon />
                <span className="max-sm:sr-only">对话</span>
              </ToggleGroupItem>
            )}
            {project && (
              <ToggleGroupItem value="files" aria-label="文件">
                <FolderOpenIcon />
                <span className="max-sm:sr-only">文件</span>
              </ToggleGroupItem>
            )}
          </ToggleGroup>
        )}
        <SessionActions
          session={session}
          canArchive={!!project}
          wide={wide}
          fontSize={view === "terminal" ? fontSize : null}
          onFontSize={changeFontSize}
        />
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {view === "terminal" ? (
          !theme ? (
            <Loading label="加载终端…" />
          ) : (
          <Suspense fallback={<Loading label="加载终端…" />}>
            <GhosttyTerminal
              key={`${paneId}:${themeKey(theme)}`}
              ref={term}
              paneId={paneId}
              theme={theme}
              padding={padding}
              fontSize={fontSize}
              onFile={upload}
              onFontSize={changeFontSize}
              onPickFile={() => fileInput.current?.click()}
              onSwitchToChat={session.kind === "shell" ? undefined : () => chooseView("bubbles")}
              onCtrlChange={setCtrl}
            />
          </Suspense>
          )
        ) : view === "files" && project ? (
          <FileBrowser
            projectId={project.id}
            projectName={project.name}
            projectPath={project.path}
            path={filesPath ?? cwdInProject}
            onNavigate={setFilesPath}
            compact={!wide}
          />
        ) : (
          <BubblesView
            paneId={paneId}
            projectId={project?.id ?? null}
            agent={session.kind === "codex" ? "codex" : "claude"}
            status={session.status}
          />
        )}
      </div>

      {view === "bubbles" && session.status === "blocked" && (
        <button
          className="flex items-center gap-2 border-t border-destructive/40 bg-destructive/10 px-3 py-2 text-left text-sm text-destructive"
          onClick={() => chooseView("terminal")}
        >
          <TriangleAlertIcon className="size-4 shrink-0" />
          需要你处理（权限确认或选项菜单），切到终端操作
        </button>
      )}

      {view === "terminal" && (
        <KeyBar
          term={term}
          showKeys={!wide}
          ctrl={ctrl}
          composerOpen={composerOpen}
          onToggleComposer={() => setComposerOpen(!composerOpen)}
          onPickFile={() => fileInput.current?.click()}
        />
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void (async () => {
            for (const f of files) {
              const path = await upload(f);
              if (path) term.current?.paste(`${path} `);
            }
            term.current?.focus();
          })();
        }}
      />

      {(view === "bubbles" || (view === "terminal" && composerOpen)) && (
        <Composer
          paneId={paneId}
          projectId={project?.id ?? null}
          kind={session.kind}
          centered={view === "bubbles"}
          onSent={() => setComposerOpen(false)}
        />
      )}
    </div>
  );
}

function BubblesView(props: { paneId: string; projectId: string | null; agent: "claude" | "codex"; status: Session["status"] }) {
  const pane = usePane(props.paneId);
  return (
    <Bubbles
      entries={pane?.transcript ?? []}
      projectId={props.projectId}
      conversationId={pane?.conversationId ?? null}
      agent={props.agent}
      status={props.status}
    />
  );
}
