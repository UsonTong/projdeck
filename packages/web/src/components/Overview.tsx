import type { AgentKind, ArchivedSession, Overview, ProjectView, Session, SessionKind } from "@projdeck/shared";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderInputIcon,
  FolderOpenIcon,
  GripVerticalIcon,
  InboxIcon,
  PlusIcon,
  Settings2Icon,
  SettingsIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import { Eye, EyeOff, Plus, X } from "lucide";
import { MorphIcon } from "morphicons/react";
import { closestCenter, DndContext, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { setDevicePref } from "@/lib/devicePrefs";
import { isTouchDevice, useSwipeReveal } from "@/lib/swipe";
import { sortProjects, sortProjectSessions, sortUnassigned, UNASSIGNED_SORTS, useUnassignedSort } from "@/lib/sessionOrder";
import { KIND_LABEL, markLaunching, STATUS_LABEL, statusRank } from "@/lib/session";
import { formatDateTime, useTimeZone } from "@/lib/time";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { useLive } from "../live.ts";
import { openFiles, openSession } from "../router.ts";
import { AddProjectDialog } from "./AddProject.tsx";
import { AgentIcon } from "./AgentIcon.tsx";
import { confirmDialog } from "./Confirm.tsx";
import { ProjectSettingsDialog } from "./ProjectSettings.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

const fail = (err: unknown) => toast.error((err as Error).message);

/** 鼠标悬停才出现的操作；触屏设备没有悬停，始终显示。 */
const HOVER_REVEAL = "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100";
/** 会话行的操作按钮：鼠标悬停时出现；触屏上不显示，改为左滑露出（见 useSwipeReveal）、长按出菜单。 */
const ROW_ACTIONS = "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:hidden";
/** 左滑露出的按钮宽度。 */
const SWIPE_BUTTON = 72;

const shortPath = (p: string) => p.replace(/^\/home\/[^/]+/, "~");

type Tab = "projects" | "unassigned" | "archived";

export function OverviewPage({ activePane, activeFiles }: { activePane: string | null; activeFiles: string | null }) {
  const { overview } = useLive();
  const [tab, setTab] = useState<Tab>("projects");
  const [showHidden, setShowHidden] = useState(false);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);

  if (!overview) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  const visible = (s: Session) => showHidden || !s.hidden;
  const hiddenCount = [...overview.projects.flatMap((p) => p.sessions), ...overview.unassigned].filter((s) => s.hidden).length;
  const unassigned = overview.unassigned.filter(visible);
  const archivedCount = overview.archived.length + overview.projects.filter((p) => p.archived).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 一行：左边切换列表，右边操作 */}
      <header className="flex items-center gap-1 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-w-0 flex-1">
          <TabsList className="w-full">
            <TabsTrigger value="projects">项目</TabsTrigger>
            <TabsTrigger value="unassigned">
              未归属
              {unassigned.length > 0 && <Count n={unassigned.length} />}
            </TabsTrigger>
            <TabsTrigger value="archived">
              归档
              {archivedCount > 0 && <Count n={archivedCount} />}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex shrink-0 items-center">
          {hiddenCount > 0 && (
            <IconAction label={showHidden ? "不显示隐藏的会话" : `显示隐藏的会话（${hiddenCount}）`} onClick={() => setShowHidden(!showHidden)}>
              <MorphIcon icon={showHidden ? Eye : EyeOff} />
            </IconAction>
          )}
          <IconAction label="设置" onClick={() => setSettings(true)}>
            <SettingsIcon />
          </IconAction>
          <IconAction label="添加项目" primary onClick={() => setAdding(true)}>
            <MorphIcon icon={adding ? X : Plus} />
          </IconAction>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        {tab === "projects" && (
          <ProjectsTab overview={overview} visible={visible} activePane={activePane} activeFiles={activeFiles} onAdd={() => setAdding(true)} />
        )}
        {tab === "unassigned" && <UnassignedTab sessions={unassigned} activePane={activePane} />}
        {tab === "archived" && <ArchivedTab overview={overview} />}
      </div>

      <AddProjectDialog open={adding} onOpenChange={setAdding} />
      <SettingsDialog open={settings} onOpenChange={setSettings} />
    </div>
  );
}

function Count({ n }: { n: number }) {
  return <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground tabular-nums">{n}</span>;
}

/** 带提示的图标按钮。 */
function IconAction(props: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  destructive?: boolean;
  /** 主要操作：实心按钮。 */
  primary?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={props.primary ? "default" : "ghost"}
          size="icon-sm"
          aria-label={props.label}
          className={cn(props.destructive && "hover:text-destructive", props.className)}
          onClick={(e) => {
            e.stopPropagation();
            props.onClick();
          }}
        >
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}

function SectionEmpty({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children?: ReactNode }) {
  return (
    <Empty className="mt-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

function ProjectsTab(props: {
  overview: Overview;
  visible: (s: Session) => boolean;
  activePane: string | null;
  activeFiles: string | null;
  onAdd: () => void;
}) {
  const projects = sortProjects(props.overview.projects);

  if (projects.length === 0) {
    return (
      <SectionEmpty icon={<FolderOpenIcon />} title="还没有项目" description="新建一个项目，或导入 herdr 里正在使用的文件夹。">
        <Button size="sm" onClick={props.onAdd}>
          <PlusIcon data-icon="inline-start" />
          添加项目
        </Button>
      </SectionEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {projects.map((p) => (
        <ProjectGroup
          key={p.id}
          project={p}
          sessions={p.sessions.filter(props.visible)}
          activePane={props.activePane}
          filesOpen={props.activeFiles === p.id}
        />
      ))}
    </div>
  );
}

function ProjectGroup(props: { project: ProjectView; sessions: Session[]; activePane: string | null; filesOpen: boolean }) {
  const { project, sessions, activePane } = props;
  const [settings, setSettings] = useState(false);

  const start = async (kind: SessionKind) => {
    try {
      const { paneId } = await api.startSession(project.id, kind);
      if (kind !== "shell") markLaunching(paneId);
      openSession(paneId);
    } catch (err) {
      fail(err);
    }
  };

  const sorted = sortProjectSessions(sessions);
  const starters: AgentKind[] = project.defaultAgent === "codex" ? ["codex", "claude"] : ["claude", "codex"];

  return (
    <section>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-1 rounded-md px-2 py-1">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{project.name}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground" title={project.path}>
                {shortPath(project.path)}
              </div>
            </div>
            {/* 新开会话：直接点图标，不用下拉菜单 */}
            <div className="flex shrink-0 items-center">
              {starters.map((k) => (
                <IconAction key={k} label={`新开 ${KIND_LABEL[k]}`} onClick={() => void start(k)}>
                  <AgentIcon kind={k} size="xs" plus />
                </IconAction>
              ))}
              <IconAction label="新开临时终端" onClick={() => void start("shell")}>
                <AgentIcon kind="shell" size="xs" plus />
              </IconAction>
              <IconAction label="文件" onClick={() => openFiles(project.id)} className={props.filesOpen ? "bg-accent" : undefined}>
                <FolderOpenIcon />
              </IconAction>
              <IconAction label="项目设置" onClick={() => setSettings(true)}>
                <Settings2Icon />
              </IconAction>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          {starters.map((k) => (
            <ContextMenuItem key={k} onSelect={() => void start(k)}>
              新开 {KIND_LABEL[k]}
            </ContextMenuItem>
          ))}
          <ContextMenuItem onSelect={() => void start("shell")}>新开临时终端</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => openFiles(project.id)}>文件</ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyPath(project.path)}>复制路径</ContextMenuItem>
          <ContextMenuItem onSelect={() => setSettings(true)}>项目设置…</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {sorted.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">没有运行中的会话，点上方图标新开一个</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {sorted.map((s) => (
            <SessionRow key={s.paneId} session={s} project={project} active={s.paneId === activePane} />
          ))}
        </div>
      )}
      <ProjectSettingsDialog project={project} open={settings} onOpenChange={setSettings} />
    </section>
  );
}

function SessionRow({
  session: s,
  project,
  active,
  handle,
}: {
  session: Session;
  project: ProjectView | null;
  active: boolean;
  /** 触屏上拖动排序的把手（herdr 顺序下）。 */
  handle?: ReactNode;
}) {
  const projectId = project?.id ?? null;
  const swipe = useSwipeReveal(SWIPE_BUTTON * 2);
  const archive = async () => {
    if (s.status === "working") {
      const ok = await confirmDialog({
        title: "归档正在工作的会话？",
        description: "归档会立即关闭这个 pane，正在进行的任务会被中断。对话可以之后恢复。",
        action: "归档",
        destructive: true,
      });
      if (!ok) return;
    }
    await api.archive(s.paneId).catch(fail);
  };

  const importFolder = async () => {
    await api.createProject({ path: s.cwd }).then(() => toast.success(`已导入 ${shortPath(s.cwd)}`), fail);
  };

  const close = async () => {
    const ok = await confirmDialog({
      title: "关闭这个终端？",
      description: "pane 会被关闭，里面正在运行的命令也会结束。",
      action: "关闭",
      destructive: true,
    });
    if (ok) await api.close(s.paneId).catch(fail);
  };

  const [moving, setMoving] = useState(false);

  // 会话目录在项目里时，可以直接在文件管理器里打开
  const inProject = project && (s.cwd === project.path || s.cwd.startsWith(project.path + "/"));

  const status = STATUS_LABEL[s.status];
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="relative overflow-hidden rounded-lg">
          {/* 左滑露出的操作，在行的下面 */}
          {swipe.offset < 0 && (
            <div className="absolute inset-y-0 right-0 flex text-xs font-medium" style={{ width: SWIPE_BUTTON * 2 }}>
              <button
                className="flex flex-1 flex-col items-center justify-center gap-1 bg-secondary text-secondary-foreground"
                onClick={() => (swipe.close(), void api.setHidden(s.paneId, !s.hidden).catch(fail))}
              >
                <MorphIcon icon={s.hidden ? Eye : EyeOff} size={18} />
                {s.hidden ? "取消隐藏" : "隐藏"}
              </button>
              <button
                className="flex flex-1 flex-col items-center justify-center gap-1 bg-destructive/85 text-white"
                onClick={() => (swipe.close(), void (s.kind === "shell" ? close() : archive()))}
              >
                {s.kind === "shell" ? <XCircleIcon className="size-[18px]" /> : <ArchiveIcon className="size-[18px]" />}
                {s.kind === "shell" ? "关闭" : "归档"}
              </button>
            </div>
          )}
          <div
            {...swipe.handlers}
            style={{ transform: swipe.offset ? `translateX(${swipe.offset}px)` : undefined }}
            className={cn(
              "group/row relative flex touch-pan-y items-center gap-2.5 rounded-lg bg-background px-2 py-1.5 transition-colors hover:bg-accent/60",
              !swipe.dragging && "transition-[background-color,transform]",
              active && "bg-accent hover:bg-accent",
              s.hidden && "opacity-50",
            )}
          >
            <AgentIcon kind={s.kind} status={s.status} />
            <div className="min-w-0 flex-1">
              {/* after: 伪元素铺满整行，整行可点；操作按钮用 z-10 浮在上面 */}
              <button className="block w-full truncate text-left text-sm after:absolute after:inset-0" onClick={() => openSession(s.paneId)}>
                {s.title}
              </button>
              <div className="truncate text-xs text-muted-foreground">
                {s.restoreError ? (
                  <span className="text-destructive">目录已不存在</span>
                ) : status && s.status !== "idle" ? (
                  <span
                    className={cn(
                      s.status === "working" && "text-status-working",
                      s.status === "blocked" && "text-status-blocked",
                      s.status === "done" && "text-status-done",
                    )}
                  >
                    {status}
                  </span>
                ) : (
                  KIND_LABEL[s.kind]
                )}
                {!projectId && <span className="font-mono"> · {shortPath(s.cwd)}</span>}
              </div>
            </div>
            <div className={cn("relative z-10 flex shrink-0 items-center", ROW_ACTIONS)}>
              {!projectId && s.kind !== "shell" && (
                <IconAction label={`把会话启动时的目录 ${shortPath(s.cwd)} 导入为项目`} onClick={() => void importFolder()}>
                  <FolderInputIcon />
                </IconAction>
              )}
              <IconAction label={s.hidden ? "取消隐藏" : "隐藏"} onClick={() => void api.setHidden(s.paneId, !s.hidden).catch(fail)}>
                <MorphIcon icon={s.hidden ? Eye : EyeOff} />
              </IconAction>
              {s.kind !== "shell" && (
                <IconAction label="归档（关闭 pane，保留对话）" onClick={() => void archive()}>
                  <ArchiveIcon />
                </IconAction>
              )}
            </div>
            {handle}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => openSession(s.paneId)}>打开</ContextMenuItem>
        <ContextMenuItem onSelect={() => window.open(`${location.pathname}#/s/${encodeURIComponent(s.paneId)}`, "_blank")}>
          在新标签页打开
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copyPath(s.cwd)}>复制目录路径</ContextMenuItem>
        {inProject && <ContextMenuItem onSelect={() => openFiles(project.id, s.cwd.slice(project.path.length + 1))}>在文件中查看</ContextMenuItem>}
        <ContextMenuItem onSelect={() => setMoving(true)}>{projectId ? "移到其他项目…" : "移到项目…"}</ContextMenuItem>
        {!projectId && <ContextMenuItem onSelect={() => void importFolder()}>导入 {shortPath(s.cwd)} 为项目</ContextMenuItem>}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void api.setHidden(s.paneId, !s.hidden).catch(fail)}>{s.hidden ? "取消隐藏" : "隐藏"}</ContextMenuItem>
        {s.kind !== "shell" && <ContextMenuItem onSelect={() => void archive()}>归档（关闭 pane，保留对话）</ContextMenuItem>}
        {s.kind === "shell" && (
          <ContextMenuItem variant="destructive" onSelect={() => void close()}>
            关闭终端
          </ContextMenuItem>
        )}
      </ContextMenuContent>
      <MoveToProjectDialog session={s} currentProjectId={projectId} open={moving} onOpenChange={setMoving} />
    </ContextMenu>
  );
}

/**
 * 把会话移到某个项目。在上级目录启动、再进入项目目录工作的会话，按目录无法自动归属，在这里手动指定。
 * 用列表直接点选，不用下拉菜单。
 */
function MoveToProjectDialog(props: { session: Session; currentProjectId: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { overview } = useLive();
  const projects = (overview?.projects ?? []).filter((p) => !p.archived && p.id !== props.currentProjectId);
  const move = async (p: ProjectView) => {
    try {
      await api.moveToProject(props.session.paneId, p.id);
      toast.success(`已移到 ${p.name}`);
      props.onOpenChange(false);
    } catch (err) {
      fail(err);
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>移到项目</DialogTitle>
          <DialogDescription>「{props.session.title}」会一直归在选中的项目下，文件、上传都用这个项目的目录。</DialogDescription>
        </DialogHeader>
        {projects.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">还没有其他项目。先点右上角的 ＋ 导入项目文件夹。</p>
        ) : (
          <div className="-mx-1 flex max-h-80 flex-col gap-0.5 overflow-y-auto px-1">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => void move(p)}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent"
              >
                <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{p.name}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{shortPath(p.path)}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const copyPath = async (path: string) => {
  if (await copyText(path)) toast.success("已复制路径");
  else toast.error("复制失败");
};

// ---------------------------------------------------------------------------
// 未归属
// ---------------------------------------------------------------------------

/**
 * herdr 顺序下的一行，拖动的是会话所在的 herdr 工作区。
 * 鼠标：整行按住拖动。触屏：只能按住右侧的把手拖（长按整行是菜单，左滑是操作按钮）。
 */
function SortableRow(props: { session: Session; active: boolean; draggedRef: React.RefObject<boolean>; touch: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.session.paneId });
  const handle = props.touch ? (
    <span {...listeners} className="relative z-10 -mr-1 flex shrink-0 touch-none items-center self-stretch px-2 text-muted-foreground" aria-label="拖动排序">
      <GripVerticalIcon className="size-4" />
    </span>
  ) : undefined;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-10 rounded-lg bg-background shadow-lg ring-1 ring-border")}
      // 拖动结束时浏览器还会补发一次 click，不能把它当成「打开会话」
      onClickCapture={(e) => props.draggedRef.current && (e.stopPropagation(), e.preventDefault())}
      {...attributes}
      {...(props.touch ? {} : listeners)}
    >
      <SessionRow session={props.session} project={null} active={props.active} handle={handle} />
    </div>
  );
}

function UnassignedTab({ sessions, activePane }: { sessions: Session[]; activePane: string | null }) {
  const sort = useUnassignedSort();
  const [touch] = useState(isTouchDevice);
  // 拖动后先按新顺序显示，等 herdr 的新顺序推送过来再以它为准
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  const draggedRef = useRef(false);
  const sorted = sortUnassigned(sessions, sort);
  const orderKey = sorted.map((s) => s.paneId).join(",");
  useEffect(() => setOptimistic(null), [orderKey]);
  const shown = optimistic ? optimistic.map((id) => sorted.find((s) => s.paneId === id)).filter((s): s is Session => !!s) : sorted;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // 触屏上只从把手开始拖，按下即可拖动
    useSensor(TouchSensor, { activationConstraint: { distance: 4 } }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setTimeout(() => (draggedRef.current = false), 0);
    if (!over || active.id === over.id) return;
    const ids = shown.map((s) => s.paneId);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    setOptimistic(next);
    const index = next.indexOf(String(active.id));
    void api.moveBefore(String(active.id), next[index + 1] ?? null).catch((err) => {
      setOptimistic(null);
      fail(err);
    });
  };

  if (sessions.length === 0) {
    return <SectionEmpty icon={<InboxIcon />} title="没有未归属的会话" description="不在任何项目文件夹里启动的会话会出现在这里。" />;
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-end px-2 pb-1.5">
        <div className="flex shrink-0 rounded-md bg-muted p-0.5">
          {UNASSIGNED_SORTS.map((o) => (
            <Tooltip key={o.value}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setDevicePref("unassignedSort", o.value)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
                    sort === o.value && "bg-background text-foreground shadow-xs",
                  )}
                >
                  {o.label}
                </button>
              </TooltipTrigger>
              <TooltipContent>{o.hint}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
      {sort === "herdr" ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={() => (draggedRef.current = true)} onDragEnd={onDragEnd}>
          <SortableContext items={shown.map((s) => s.paneId)} strategy={verticalListSortingStrategy}>
            {shown.map((s) => (
              <SortableRow key={s.paneId} session={s} active={s.paneId === activePane} draggedRef={draggedRef} touch={touch} />
            ))}
          </SortableContext>
        </DndContext>
      ) : (
        shown.map((s) => <SessionRow key={s.paneId} session={s} project={null} active={s.paneId === activePane} />)
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 归档
// ---------------------------------------------------------------------------

function ArchivedTab({ overview }: { overview: Overview }) {
  const archivedProjects = overview.projects.filter((p) => p.archived);
  if (overview.archived.length === 0 && archivedProjects.length === 0) {
    return <SectionEmpty icon={<ArchiveIcon />} title="没有归档" description="归档的会话会关闭 pane 但保留对话，随时可以恢复。" />;
  }
  return (
    <div className="flex flex-col gap-4">
      {overview.archived.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">会话</p>
          {overview.archived.map((a) => (
            <ArchivedRow key={a.id} item={a} projectName={overview.projects.find((p) => p.id === a.projectId)?.name} />
          ))}
        </div>
      )}
      {archivedProjects.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">项目</p>
          {archivedProjects.map((p) => (
            <ContextMenu key={p.id}>
              <ContextMenuTrigger asChild>
                <div className="group/row flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent/60">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border">
                    <FolderOpenIcon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{p.name}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{shortPath(p.path)}</div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void api.updateProject(p.id, { archived: false }).catch(fail)}>
                    <ArchiveRestoreIcon data-icon="inline-start" />
                    恢复
                  </Button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-52">
                <ContextMenuItem onSelect={() => void api.updateProject(p.id, { archived: false }).catch(fail)}>恢复项目</ContextMenuItem>
                <ContextMenuItem onSelect={() => void copyPath(p.path)}>复制路径</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      )}
    </div>
  );
}

function ArchivedRow({ item, projectName }: { item: ArchivedSession; projectName?: string }) {
  const timeZone = useTimeZone();
  const restore = async () => {
    try {
      const { paneId } = await api.restore(item.id);
      markLaunching(paneId);
      openSession(paneId);
    } catch (err) {
      fail(err);
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: "删除这条归档记录？",
      description: "对话文件本身不会删除，之后仍可在 claude / codex 里手动 resume。",
      action: "删除",
      destructive: true,
    });
    if (ok) await api.deleteArchive(item.id).catch(fail);
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group/row flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-accent/60">
          <AgentIcon kind={item.kind} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{item.title}</div>
            <div className="truncate text-xs text-muted-foreground">
              {projectName ?? (item.projectId ? item.projectId : "未归属")} · {formatDateTime(item.archivedAt, timeZone)}
            </div>
          </div>
          <IconAction label="删除归档记录" destructive className={HOVER_REVEAL} onClick={() => void remove()}>
            <Trash2Icon />
          </IconAction>
          <Button variant="outline" size="sm" onClick={() => void restore()}>
            <ArchiveRestoreIcon data-icon="inline-start" />
            恢复
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => void restore()}>恢复（resume 对话）</ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyPath(item.cwd)}>复制目录路径</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => void remove()}>
          删除归档记录
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
