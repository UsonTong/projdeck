import type { AgentKind, ArchivedSession, CcSwitchStatus, Overview, ProjectView, Session, SessionKind } from "@projdeck/shared";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  ArrowRightLeftIcon,
  SmartphoneIcon,
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
import {
  closestCenter,
  DndContext,
  pointerWithin,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
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
import {
  PROJECT_SORTS,
  sortProjects,
  sortProjectSessions,
  sortUnassigned,
  UNASSIGNED_SORTS,
  useProjectSort,
  useUnassignedSort,
  type ProjectSort,
} from "@/lib/sessionOrder";
import { AGENT_KINDS, KIND_LABEL, markLaunching, STATUS_LABEL, statusRank } from "@/lib/session";
import { formatDateTime, useTimeZone } from "@/lib/time";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { useLive } from "../live.ts";
import { useFlip } from "../lib/flip.ts";
import { openCcSwitch, openDevices, openFiles, openHarness, openSession } from "../router.ts";
import { AddProjectDialog } from "./AddProject.tsx";
import { InlineInput } from "./InlineInput.tsx";
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

export function OverviewPage({ activePane, activeFiles, enter }: { activePane: string | null; activeFiles: string | null; enter?: string }) {
  const { overview } = useLive();
  const [tab, setTab] = useState<Tab>("projects");
  const [showHidden, setShowHidden] = useState(false);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);
  // 装了 CC Switch 才显示它的入口
  const [ccswitch, setCcswitch] = useState<CcSwitchStatus | null>(null);
  useEffect(() => void api.ccswitch().then(setCcswitch, () => undefined), []);

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
    <div className={cn("flex min-h-0 flex-1 flex-col", enter)}>
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
          {ccswitch?.installed && (
            <IconAction label="CC Switch：用量、切换供应商" onClick={() => openCcSwitch()}>
              <ArrowRightLeftIcon />
            </IconAction>
          )}
          <IconAction label="DeepSeek Harness 原版" onClick={openHarness}>
            <AgentIcon kind="harness" size="xs" />
          </IconAction>
          <IconAction label="设备：连进来的手机" onClick={() => openDevices()}>
            <SmartphoneIcon />
          </IconAction>
          <IconAction label="设置" onClick={() => setSettings(true)}>
            <SettingsIcon />
          </IconAction>
          <IconAction label="添加项目" primary onClick={() => setAdding(true)}>
            <MorphIcon icon={adding ? X : Plus} />
          </IconAction>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        {/* 切换标签时内容轻轻上浮（key 变了才重新播放） */}
        <div key={tab} className="motion-rise">
          {tab === "projects" && (
            <ProjectsTab overview={overview} visible={visible} activePane={activePane} activeFiles={activeFiles} onAdd={() => setAdding(true)} />
          )}
          {tab === "unassigned" && <UnassignedTab sessions={unassigned} activePane={activePane} />}
          {tab === "archived" && <ArchivedTab overview={overview} />}
        </div>
      </div>

      <AddProjectDialog open={adding} onOpenChange={setAdding} />
      <SettingsDialog open={settings} onOpenChange={setSettings} />
    </div>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="ml-1 min-w-4 rounded-full bg-foreground/10 px-1.5 text-center text-[10px] leading-4 text-foreground/70 tabular-nums">{n}</span>
  );
}

/** 列表右上角的排序方式：直接点选，不用下拉菜单。 */
function SortSwitch<T extends string>(props: {
  value: T;
  options: { value: T; label: string; hint: string }[];
  onChange: (v: T) => void;
  /** 同一行右侧的内容（排序在左、这个在右） */
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-center px-2 pb-1.5", props.children ? "justify-between gap-2" : "justify-end")}>
      <div className="flex shrink-0 rounded-md bg-muted p-0.5">
        {props.options.map((o) => (
          <Tooltip key={o.value}>
            <TooltipTrigger asChild>
              <button
                onClick={() => props.onChange(o.value)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
                  props.value === o.value && "bg-background text-foreground shadow-xs",
                )}
              >
                {o.label}
              </button>
            </TooltipTrigger>
            <TooltipContent>{o.hint}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      {props.children}
    </div>
  );
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
  const sort = useProjectSort();
  const [touch] = useState(isTouchDevice);
  // 拖动后先按新顺序显示，等服务端的新顺序推送过来再以它为准
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  const draggedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef, sort !== "custom"); // 拖动排序时交给 dnd-kit，别的排序方式切换/变动时让项目滑到新位置
  const projects = sortProjects(props.overview.projects, sort);
  const orderKey = projects.map((p) => p.id).join(",");
  useEffect(() => setOptimistic(null), [orderKey]);
  const shown = optimistic ? optimistic.map((id) => projects.find((p) => p.id === id)).filter((p): p is ProjectView => !!p) : projects;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 4 } }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setTimeout(() => (draggedRef.current = false), 0);
    if (!over || active.id === over.id) return;
    const ids = shown.map((p) => p.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    setOptimistic(next);
    void api.reorderProjects(next).catch((err) => {
      setOptimistic(null);
      fail(err);
    });
  };

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
  const group = (p: ProjectView, drag?: DragHandle) => (
    <ProjectGroup
      key={p.id}
      project={p}
      sessions={p.sessions.filter(props.visible)}
      sort={sort}
      activePane={props.activePane}
      filesOpen={props.activeFiles === p.id}
      drag={drag}
    />
  );
  return (
    <div className="flex flex-col">
      <SortSwitch value={sort} options={PROJECT_SORTS} onChange={(v) => setDevicePref("projectSort", v)} />
      {sort === "custom" ? (
        // 项目高矮差别很大（会话多的很长），按指针落在哪个项目上判断，而不是比较中心点
        <DndContext sensors={sensors} collisionDetection={pointerFirst} onDragStart={() => (draggedRef.current = true)} onDragEnd={onDragEnd}>
          <SortableContext items={shown.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-4">
              {shown.map((p) => (
                <SortableProject key={p.id} id={p.id} touch={touch} draggedRef={draggedRef}>
                  {(drag) => group(p, drag)}
                </SortableProject>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div ref={listRef} className="flex flex-col gap-4">
          {shown.map((p) => group(p))}
        </div>
      )}
    </div>
  );
}

const pointerFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

/** 拖动项目的把手：鼠标按住标题拖，触屏按住标题右侧的把手拖。 */
type DragHandle = { listeners: Record<string, unknown> | undefined; touch: boolean };

function SortableProject(props: {
  id: string;
  touch: boolean;
  draggedRef: React.RefObject<boolean>;
  children: (drag: DragHandle) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-10 rounded-lg bg-background shadow-lg ring-1 ring-border")}
      // 拖动结束时浏览器还会补发一次 click，不能把它当成点击
      onClickCapture={(e) => props.draggedRef.current && (e.stopPropagation(), e.preventDefault())}
      {...attributes}
      tabIndex={-1}
    >
      {props.children({ listeners, touch: props.touch })}
    </div>
  );
}

function ProjectGroup(props: {
  project: ProjectView;
  sessions: Session[];
  sort: ProjectSort;
  activePane: string | null;
  filesOpen: boolean;
  drag?: DragHandle;
}) {
  const { project, sessions, activePane, drag } = props;
  const { overview } = useLive();
  const availableAgents = AGENT_KINDS.filter((k) => k !== "harness" || overview?.harness?.configured);
  const rowsRef = useRef<HTMLDivElement>(null);
  useFlip(rowsRef);
  const [settings, setSettings] = useState(false);
  const [editingNote, setEditingNote] = useState(false);

  const start = async (kind: SessionKind) => {
    try {
      const { paneId } = await api.startSession(project.id, kind);
      if (kind !== "shell") markLaunching(paneId);
      openSession(paneId);
    } catch (err) {
      fail(err);
    }
  };

  const sorted = sortProjectSessions(sessions, props.sort);
  // 行内只留默认 agent 和 DeepSeek，其余在右键菜单里，避免一排七八个图标。
  const starters = availableAgents.filter((k) => k === project.defaultAgent || k === "harness");
  const menuStarters: AgentKind[] = availableAgents.includes(project.defaultAgent)
    ? [project.defaultAgent, ...availableAgents.filter((k) => k !== project.defaultAgent)]
    : availableAgents;

  return (
    <section data-flip={project.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn("flex items-center gap-1 rounded-md px-2 py-1", drag && !drag.touch && "cursor-grab active:cursor-grabbing")}
            {...(drag && !drag.touch ? drag.listeners : {})}
          >
            {/* 备注醒目地显示在最上面，文件夹名和路径退到下面一行；双击编辑备注 */}
            <div className="min-w-0 flex-1" onDoubleClick={() => setEditingNote(true)}>
              {editingNote ? (
                <InlineInput
                  label="项目备注"
                  initial={project.note ?? ""}
                  placeholder={`给「${project.name}」写个备注，留空清除`}
                  onSave={(note) => api.updateProject(project.id, { note })}
                  onDone={() => setEditingNote(false)}
                  className="text-base font-semibold"
                />
              ) : project.note ? (
                <div className="truncate text-base leading-6 font-semibold">{project.note}</div>
              ) : (
                <div className="truncate text-sm font-semibold">{project.name}</div>
              )}
              <div className="truncate text-[11px] text-muted-foreground" title={project.path}>
                {project.note && <span className="font-medium text-foreground/70">{project.name} · </span>}
                <span className="font-mono">{shortPath(project.path)}</span>
              </div>
            </div>
            {/* 新开会话：直接点图标，不用下拉菜单 */}
            <div className="flex shrink-0 items-center">
              {starters.map((k) => (
                <IconAction key={k} label={`新开 ${KIND_LABEL[k]}`} onClick={() => void start(k)}>
                  <AgentIcon kind={k} size="xs" />
                </IconAction>
              ))}
              <IconAction label="新开临时终端" onClick={() => void start("shell")}>
                <AgentIcon kind="shell" size="xs" />
              </IconAction>
              <IconAction label="文件" onClick={() => openFiles(project.id)} className={props.filesOpen ? "bg-accent" : undefined}>
                <FolderOpenIcon />
              </IconAction>
              <IconAction label="项目设置" onClick={() => setSettings(true)}>
                <Settings2Icon />
              </IconAction>
              {drag?.touch && (
                <span {...drag.listeners} className="-mr-1 flex touch-none items-center self-stretch px-1.5 text-muted-foreground" aria-label="拖动排序">
                  <GripVerticalIcon className="size-4" />
                </span>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => editingNote && e.preventDefault()}>
          <ContextMenuItem onSelect={() => setEditingNote(true)}>{project.note ? "修改备注" : "添加备注"}</ContextMenuItem>
          <ContextMenuSeparator />
          {menuStarters.map((k) => (
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
        <div ref={rowsRef} className="flex flex-col gap-0.5">
          {sorted.filter((s) => s.kind !== "harness").map((s) => (
            <SessionRow key={s.paneId} session={s} project={project} active={s.paneId === activePane} />
          ))}
          <HarnessGroup sessions={sorted.filter((s) => s.kind === "harness")} project={project} activePane={activePane} />
        </div>
      )}
      <ProjectSettingsDialog project={project} open={settings} onOpenChange={setSettings} />
    </section>
  );
}

/** DeepSeek 会话多时折成一组，默认收起；当前正在看的那条会自动展开。 */
function HarnessGroup({ sessions, project, activePane }: { sessions: Session[]; project: ProjectView | null; activePane: string | null }) {
  const containsActive = sessions.some((s) => s.paneId === activePane);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? containsActive;
  if (sessions.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
      >
        <AgentIcon kind="harness" size="xs" />
        <span className="flex-1 truncate text-sm">DeepSeek</span>
        <span className="text-xs text-muted-foreground">{sessions.length} 个会话</span>
        <ChevronDownIcon className={cn("size-4 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && sessions.map((s) => (
        <SessionRow key={s.paneId} session={s} project={project} active={s.paneId === activePane} />
      ))}
    </div>
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
  const [renaming, setRenaming] = useState(false);

  // 会话目录在项目里时，可以直接在文件管理器里打开
  const inProject = project && (s.cwd === project.path || s.cwd.startsWith(project.path + "/"));

  const status = STATUS_LABEL[s.status];
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div data-flip={s.paneId} className="motion-rise relative overflow-hidden rounded-lg">
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
              {renaming ? (
                <InlineInput
                  label="会话名称"
                  initial={s.title}
                  placeholder="留空恢复自动标题"
                  onSave={(v) => api.rename(s.paneId, v || null)}
                  onDone={() => setRenaming(false)}
                  className="relative z-10 -my-0.5"
                />
              ) : (
                <button className="block w-full truncate text-left text-sm after:absolute after:inset-0" onClick={() => openSession(s.paneId)}>
                  {s.title}
                </button>
              )}
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
      <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => renaming && e.preventDefault()}>
        <ContextMenuItem onSelect={() => openSession(s.paneId)}>打开</ContextMenuItem>
        <ContextMenuItem onSelect={() => window.open(`${location.pathname}#/s/${encodeURIComponent(s.paneId)}`, "_blank")}>
          在新标签页打开
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => setRenaming(true)}>重命名</ContextMenuItem>
        {s.renamed && <ContextMenuItem onSelect={() => void api.rename(s.paneId, null).catch(fail)}>恢复自动标题</ContextMenuItem>}
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
  const { overview } = useLive();
  const [touch] = useState(isTouchDevice);
  // 拖动后先按新顺序显示，等 herdr 的新顺序推送过来再以它为准
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  const draggedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef, sort !== "herdr");
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
    const ids = shown.filter((s) => s.backend !== "harness").map((s) => s.paneId);
    if (!ids.includes(String(active.id)) || !ids.includes(String(over.id))) return;
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    setOptimistic([...next, ...shown.filter((s) => s.backend === "harness").map((s) => s.paneId)]);
    const index = next.indexOf(String(active.id));
    void api.moveBefore(String(active.id), next[index + 1] ?? null).catch((err) => {
      setOptimistic(null);
      fail(err);
    });
  };

  const start = async (kind: SessionKind) => {
    try {
      const { paneId } = await api.startUnassignedSession(kind);
      if (kind !== "shell") markLaunching(paneId);
      openSession(paneId);
    } catch (err) {
      fail(err);
    }
  };
  // 新开会话：和项目一样直接点图标，在主目录里启动，不属于任何项目
  const starters = (
    <div className="flex shrink-0 items-center">
      {AGENT_KINDS.filter((k) => k !== "harness" || overview?.harness?.configured).map((k) => (
        <IconAction key={k} label={`新开 ${KIND_LABEL[k]}（在主目录）`} onClick={() => void start(k)}>
          <AgentIcon kind={k} size="xs" />
        </IconAction>
      ))}
      <IconAction label="新开终端（在主目录）" onClick={() => void start("shell")}>
        <AgentIcon kind="shell" size="xs" />
      </IconAction>
    </div>
  );

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex justify-end px-2 pb-1">{starters}</div>
        <SectionEmpty icon={<InboxIcon />} title="没有未归属的会话" description="不在任何项目文件夹里启动的会话会出现在这里，也可以点上方图标在主目录里新开。" />
      </div>
    );
  }
  return (
    <div ref={listRef} className="flex flex-col gap-0.5">
      <SortSwitch value={sort} options={UNASSIGNED_SORTS} onChange={(v) => setDevicePref("unassignedSort", v)}>
        {starters}
      </SortSwitch>
      {sort === "herdr" ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={() => (draggedRef.current = true)} onDragEnd={onDragEnd}>
          <SortableContext items={shown.filter((s) => s.backend !== "harness").map((s) => s.paneId)} strategy={verticalListSortingStrategy}>
            {shown.filter((s) => s.backend !== "harness").map((s) => (
              <SortableRow key={s.paneId} session={s} active={s.paneId === activePane} draggedRef={draggedRef} touch={touch} />
            ))}
          </SortableContext>
        </DndContext>
      ) : (
        shown.filter((s) => s.backend !== "harness").map((s) => <SessionRow key={s.paneId} session={s} project={null} active={s.paneId === activePane} />)
      )}
      <HarnessGroup sessions={shown.filter((s) => s.backend === "harness" || s.kind === "harness")} project={null} activePane={activePane} />
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
