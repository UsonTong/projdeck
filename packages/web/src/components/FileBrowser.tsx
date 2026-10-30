import type { DirListing, FileEntry } from "@projdeck/shared";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  type LucideIcon,
  RotateCwIcon,
  UploadIcon,
} from "lucide-react";
import { Eye, EyeOff, LayoutGrid, List, Search, X } from "lucide";
import { MorphIcon } from "morphicons/react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setDevicePref, useDevicePref } from "@/lib/devicePrefs";
import { formatDateTime, useTimeZone } from "@/lib/time";
import { formatSize } from "@/lib/upload";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { confirmDialog } from "./Confirm.tsx";

/** VS Code 的编辑器体积较大，打开文件编辑时才加载。 */
const CodeEditor = lazy(() => import("./CodeEditor.tsx"));

const fail = (err: unknown) => toast.error((err as Error).message);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

function iconFor(e: FileEntry): LucideIcon {
  if (e.type === "dir") return FolderIcon;
  const n = e.name.toLowerCase();
  if (IMAGE.test(n) || n.endsWith(".svg")) return FileImageIcon;
  if (/\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/.test(n)) return FileArchiveIcon;
  if (/\.(md|txt|log|csv|pdf|docx?)$/.test(n)) return FileTextIcon;
  if (/\.(ts|tsx|js|jsx|mjs|py|go|rs|java|c|cc|cpp|h|rb|php|sh|zsh|json|ya?ml|toml|html|css|sql|vue|svelte|kt|swift)$/.test(n)) return FileCodeIcon;
  return FileIcon;
}

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 && name.length - i <= 6 ? name.slice(i + 1) : "";
};


type SortKey = "name" | "modified" | "size";

function IconButton(props: { label: string; onClick: () => void; children: ReactNode; className?: string; active?: boolean; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={props.active ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label={props.label}
          disabled={props.disabled}
          className={props.className}
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

/** 网格视图里的大图标：文件夹用主题色、图片直接显示缩略图、其他文件显示类型图标和扩展名。 */
function Thumb({ entry, src }: { entry: FileEntry; src: string }) {
  if (entry.type === "dir") return <FolderIcon className="size-14 fill-folder/25 text-folder" strokeWidth={1.25} />;
  if (IMAGE.test(entry.name)) {
    return <img src={src} alt="" loading="lazy" draggable={false} className="size-14 rounded-md bg-muted object-cover ring-1 ring-border" />;
  }
  const Icon = iconFor(entry);
  const ext = extOf(entry.name);
  return (
    <span className="relative flex size-14 items-center justify-center">
      <Icon className="size-12 text-muted-foreground" strokeWidth={1.25} />
      {ext && (
        <span className="absolute bottom-1 max-w-12 truncate rounded bg-secondary px-1 text-[9px] leading-3.5 font-medium text-secondary-foreground uppercase">
          {ext}
        </span>
      )}
    </span>
  );
}

/**
 * 项目文件管理器，界面参照 GNOME「文件」：工具栏（后退 / 前进、路径栏、搜索、视图切换）、左侧位置栏、
 * 网格 / 列表两种视图。单击打开（文件夹进入、图片预览、其他文件用 VS Code 的编辑器打开），右键（触屏长按）出菜单。
 * 范围限定在项目目录内（服务端校验，见 agentd/src/files.ts）。
 */
export function FileBrowser(props: {
  projectId: string;
  projectName: string;
  /** 项目绝对路径，用于「复制路径」。 */
  projectPath: string;
  path: string;
  onNavigate: (path: string) => void;
  /** 位置栏里列出的项目；点击切换到该项目的文件。 */
  projects?: { id: string; name: string }[];
  onOpenProject?: (projectId: string) => void;
  compact?: boolean;
  /** 打开 / 关闭编辑器时通知外层（手机上编辑时收起外层标题栏）。 */
  onEditingChange?: (editing: boolean) => void;
}) {
  const { projectId, path } = props;
  const timeZone = useTimeZone();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem("projdeck:showHiddenFiles") === "1");
  const view = useDevicePref<"grid" | "list">("fileView", "grid");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [query, setQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // 刚复制过路径的条目，菜单里短暂显示对勾
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const [upload, setUpload] = useState<{ names: string; ratio: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: "mkdir" } | { kind: "rename"; entry: FileEntry } | { kind: "preview"; entry: FileEntry }>(null);
  /** 正在编辑的文件（项目内相对路径）；编辑器占据整个文件管理器区域。 */
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setEditing(null), [projectId]);
  const { onEditingChange } = props;
  useEffect(() => onEditingChange?.(!!editing), [editing, onEditingChange]);
  const fileInput = useRef<HTMLInputElement>(null);

  // 后退 / 前进：记录在这个文件管理器里走过的路径
  const history = useRef({ stack: [path], index: 0 });
  useEffect(() => {
    const h = history.current;
    if (h.stack[h.index] === path) return;
    h.stack = [...h.stack.slice(0, h.index + 1), path];
    h.index = h.stack.length - 1;
  }, [path]);
  const go = (delta: -1 | 1) => {
    const h = history.current;
    const next = h.index + delta;
    if (next < 0 || next >= h.stack.length) return;
    h.index = next;
    props.onNavigate(h.stack[next]!);
  };

  const load = useCallback(() => {
    setError("");
    api.listDir(projectId, path, showHidden).then(setListing, (err: Error) => {
      setListing(null);
      setError(err.message);
    });
  }, [projectId, path, showHidden]);

  useEffect(load, [load]);
  // 换了目录：清掉选中和搜索
  useEffect(() => {
    setSelected(null);
    setQuery(null);
  }, [projectId, path]);

  const toggleHidden = () => {
    localStorage.setItem("projdeck:showHiddenFiles", showHidden ? "0" : "1");
    setShowHidden(!showHidden);
  };

  const uploadFiles = async (list: File[]) => {
    if (!list.length) return;
    const names = list.length === 1 ? list[0]!.name : `${list.length} 个文件`;
    setUpload({ names, ratio: 0 });
    try {
      const saved = await api.uploadToDir(projectId, path, list, (ratio) => setUpload({ names, ratio }));
      const renamed = saved.filter((s, i) => s.name !== list[i]?.name);
      toast.success(`已上传 ${names}`, renamed.length ? { description: `重名已自动改名：${renamed.map((r) => r.name).join("、")}` } : undefined);
      load();
    } catch (err) {
      fail(err);
    } finally {
      setUpload(null);
    }
  };

  const remove = async (e: FileEntry) => {
    const ok = await confirmDialog({
      title: `删除${e.type === "dir" ? "文件夹" : "文件"}「${e.name}」？`,
      description: e.type === "dir" ? "文件夹里的所有内容都会被删除，无法恢复。" : "删除后无法恢复。",
      action: "删除",
      destructive: true,
    });
    if (!ok) return;
    await api.deleteFile(projectId, join(path, e.name)).then(load, fail);
  };

  // 文件夹进入；图片预览；其他文件用编辑器打开（二进制或太大的文件编辑器里会提示并提供下载）
  const open = (e: FileEntry) =>
    e.type === "dir" ? props.onNavigate(join(path, e.name)) : IMAGE.test(e.name) ? setDialog({ kind: "preview", entry: e }) : setEditing(join(path, e.name));
  const copyPath = (e: FileEntry) => {
    const rel = join(path, e.name);
    void copyText(`${props.projectPath}/${rel}`).then(() => {
      setCopied(rel);
      toast.success("已复制路径");
    });
  };
  const download = (e: FileEntry) => (location.href = api.downloadUrl(projectId, join(path, e.name)));

  // 文件夹在前，再按选定的列排序；搜索只过滤当前文件夹
  const entries = useMemo(() => {
    const q = query?.trim().toLowerCase();
    const list = (listing?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));
    const by = (a: FileEntry, b: FileEntry) =>
      sort.key === "size" ? a.size - b.size : sort.key === "modified" ? a.modifiedAt.localeCompare(b.modifiedAt) : a.name.localeCompare(b.name, "zh");
    return list.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : sort.desc ? by(b, a) : by(a, b)));
  }, [listing, query, sort]);

  const segments = path ? path.split("/") : [];
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void uploadFiles([...e.dataTransfer.files]);
  };

  // 键盘：Enter 打开、Delete 删除、F2 重命名、Alt+← / Backspace 后退
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const entry = entries.find((x) => x.name === selected);
    if (e.key === "Enter" && entry) open(entry);
    else if (e.key === "Delete" && entry) void remove(entry);
    else if (e.key === "F2" && entry) setDialog({ kind: "rename", entry });
    else if ((e.altKey && e.key === "ArrowLeft") || e.key === "Backspace") go(-1);
    else if (e.altKey && e.key === "ArrowRight") go(1);
    else return;
    e.preventDefault();
  };

  // 单击打开（文件夹进入、文件预览）；右键时选中，供键盘快捷键使用
  const itemHandlers = (e: FileEntry) => ({
    onClick: () => open(e),
    onContextMenu: () => setSelected(e.name),
  });

  const itemMenu = (e: FileEntry) => (
    <ContextMenuContent className="w-52">
      <ContextMenuItem onSelect={() => open(e)}>
        {e.type === "dir" ? "打开" : IMAGE.test(e.name) ? "预览" : "编辑"}
        <ContextMenuShortcut>Enter</ContextMenuShortcut>
      </ContextMenuItem>
      {e.type === "file" && !IMAGE.test(e.name) && (
        <ContextMenuItem onSelect={() => setDialog({ kind: "preview", entry: e })}>只读预览</ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => download(e)}>{e.type === "dir" ? "打包下载（.tar.gz）" : "下载"}</ContextMenuItem>
      <ContextMenuItem onSelect={() => copyPath(e)}>{copied === join(path, e.name) ? "已复制" : "复制路径"}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => setDialog({ kind: "rename", entry: e })}>
        重命名…
        <ContextMenuShortcut>F2</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={() => void remove(e)}>
        删除
        <ContextMenuShortcut>Delete</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  );

  const sortHeader = (key: SortKey, label: string, className?: string) => (
    <button
      className={cn("flex items-center gap-1 hover:text-foreground", className, sort.key === key && "text-foreground")}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}
    >
      {label}
      {sort.key === key && <span className="text-[10px]">{sort.desc ? "▼" : "▲"}</span>}
    </button>
  );

  const showSidebar = !props.compact && (props.projects?.length ?? 0) > 0;

  if (editing) {
    return (
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-5" />
          </div>
        }
      >
        <CodeEditor projectId={projectId} path={editing} onClose={() => (setEditing(null), load())} />
      </Suspense>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏：后退 / 前进、路径栏（搜索时换成搜索框）、视图与操作 */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <IconButton label="后退（Alt+←）" disabled={history.current.index === 0} onClick={() => go(-1)}>
          <ChevronLeftIcon />
        </IconButton>
        <IconButton label="前进（Alt+→）" disabled={history.current.index >= history.current.stack.length - 1} onClick={() => go(1)}>
          <ChevronRightIcon />
        </IconButton>
        {query === null ? (
          <nav className="flex h-8 min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/60 px-1 text-sm [scrollbar-width:none]">
            <button className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 font-medium hover:bg-accent" onClick={() => props.onNavigate("")}>
              <FolderIcon className="size-3.5 fill-folder/25 text-folder" />
              {props.projectName}
            </button>
            {segments.map((seg, i) => (
              <span key={i} className="flex shrink-0 items-center gap-0.5">
                <span className="text-muted-foreground">/</span>
                <button
                  className={cn("rounded-md px-2 py-0.5 hover:bg-accent", i === segments.length - 1 && "font-medium")}
                  onClick={() => props.onNavigate(segments.slice(0, i + 1).join("/"))}
                >
                  {seg}
                </button>
              </span>
            ))}
          </nav>
        ) : (
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery(null)}
            placeholder={`在「${segments.at(-1) ?? props.projectName}」中搜索`}
            className="h-8 min-w-0 flex-1"
          />
        )}
        <IconButton label={query === null ? "搜索" : "关闭搜索"} active={query !== null} onClick={() => setQuery(query === null ? "" : null)}>
          <MorphIcon icon={query === null ? Search : X} />
        </IconButton>
        <IconButton label={view === "grid" ? "列表视图" : "网格视图"} onClick={() => setDevicePref("fileView", view === "grid" ? "list" : "grid")}>
          <MorphIcon icon={view === "grid" ? List : LayoutGrid} />
        </IconButton>
        <IconButton label={showHidden ? "不显示隐藏文件" : "显示隐藏文件"} active={showHidden} onClick={toggleHidden}>
          <MorphIcon icon={showHidden ? Eye : EyeOff} />
        </IconButton>
        {!props.compact && (
          <IconButton label="新建文件夹" onClick={() => setDialog({ kind: "mkdir" })}>
            <FolderPlusIcon />
          </IconButton>
        )}
        <Button size="sm" onClick={() => fileInput.current?.click()} disabled={!!upload}>
          <UploadIcon data-icon="inline-start" />
          上传
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = [...(e.target.files ?? [])];
            e.target.value = "";
            void uploadFiles(list);
          }}
        />
      </div>

      {upload && (
        <div className="border-b px-3 py-2 text-xs text-muted-foreground">
          <div className="mb-1 flex justify-between">
            <span className="truncate">正在上传 {upload.names}</span>
            <span className="tabular-nums">{Math.round(upload.ratio * 100)}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${upload.ratio * 100}%` }} />
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 位置栏：所有项目 */}
        {showSidebar && (
          <aside className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">项目</p>
            {props.projects!.map((p) => (
              <button
                key={p.id}
                onClick={() => (p.id === projectId ? props.onNavigate("") : props.onOpenProject?.(p.id))}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  p.id === projectId && "bg-accent font-medium",
                )}
              >
                <FolderIcon className="size-4 shrink-0 fill-folder/25 text-folder" />
                <span className="truncate">{p.name}</span>
              </button>
            ))}
          </aside>
        )}

        {/* 内容区，也是拖放上传区域；右键空白处出菜单 */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              tabIndex={0}
              onKeyDown={onKeyDown}
              onClick={(e) => e.target === e.currentTarget && setSelected(null)}
              className={cn(
                "relative min-h-0 flex-1 overflow-y-auto p-2 outline-none",
                dragging && "bg-accent/40 outline-2 -outline-offset-4 outline-dashed outline-ring",
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
              onDrop={onDrop}
            >
              {error ? (
                <p className="p-6 text-center text-sm text-destructive">{error}</p>
              ) : !listing ? (
                <div className="flex justify-center p-8">
                  <Spinner />
                </div>
              ) : entries.length === 0 ? (
                <Empty className="mt-4">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">{query ? <MorphIcon icon={Search} /> : <FolderIcon />}</EmptyMedia>
                    <EmptyTitle>{query ? "没有匹配的文件" : "空文件夹"}</EmptyTitle>
                    <EmptyDescription>{query ? "搜索只在当前文件夹里查找。" : "点「上传」，或把文件拖到这里。"}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : view === "grid" ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-1" onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
                  {entries.map((e) => (
                    <ContextMenu key={e.name}>
                      <ContextMenuTrigger asChild>
                        <button
                          {...itemHandlers(e)}
                          title={e.name}
                          className={cn(
                            "flex flex-col items-center gap-1.5 rounded-xl px-1.5 pt-2 pb-1.5 text-center transition-colors hover:bg-accent/60",
                            selected === e.name && "bg-accent hover:bg-accent",
                          )}
                        >
                          <Thumb entry={e} src={api.rawUrl(projectId, join(path, e.name))} />
                          <span className={cn("line-clamp-2 w-full text-xs break-all", selected === e.name && "font-medium")}>
                            {e.name}
                            {e.symlink && <span className="text-muted-foreground"> ↗</span>}
                          </span>
                        </button>
                      </ContextMenuTrigger>
                      {itemMenu(e)}
                    </ContextMenu>
                  ))}
                </div>
              ) : (
                <div className="mx-auto flex max-w-5xl flex-col">
                  {!props.compact && (
                    <div className="flex items-center gap-3 border-b px-3 pb-1.5 text-xs text-muted-foreground">
                      <span className="size-4 shrink-0" />
                      {sortHeader("name", "名称", "min-w-0 flex-1")}
                      {sortHeader("size", "大小", "w-20 shrink-0 justify-end")}
                      {sortHeader("modified", "修改时间", "w-36 shrink-0 justify-end")}
                    </div>
                  )}
                  {entries.map((e) => {
                    const Icon = iconFor(e);
                    return (
                      <ContextMenu key={e.name}>
                        <ContextMenuTrigger asChild>
                          <button
                            {...itemHandlers(e)}
                            className={cn(
                              "flex items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-accent/60",
                              selected === e.name && "bg-accent hover:bg-accent",
                            )}
                          >
                            <Icon className={cn("size-4 shrink-0", e.type === "dir" ? "fill-folder/25 text-folder" : "text-muted-foreground")} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm">
                                {e.name}
                                {e.symlink && <span className="ml-1.5 text-xs text-muted-foreground">↗</span>}
                              </div>
                              {props.compact && (
                                <div className="truncate text-xs text-muted-foreground">
                                  {e.type === "file" && `${formatSize(e.size)} · `}
                                  {formatDateTime(e.modifiedAt, timeZone)}
                                </div>
                              )}
                            </div>
                            {!props.compact && (
                              <>
                                <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{e.type === "file" ? formatSize(e.size) : ""}</span>
                                <span className="w-36 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatDateTime(e.modifiedAt, timeZone)}</span>
                              </>
                            )}
                          </button>
                        </ContextMenuTrigger>
                        {itemMenu(e)}
                      </ContextMenu>
                    );
                  })}
                </div>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onSelect={() => setDialog({ kind: "mkdir" })}>新建文件夹…</ContextMenuItem>
            <ContextMenuItem onSelect={() => fileInput.current?.click()}>上传文件…</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => setDevicePref("fileView", view === "grid" ? "list" : "grid")}>
              {view === "grid" ? "列表视图" : "网格视图"}
            </ContextMenuItem>
            <ContextMenuItem onSelect={toggleHidden}>{showHidden ? "不显示隐藏文件" : "显示隐藏文件"}</ContextMenuItem>
            <ContextMenuItem onSelect={load}>
              刷新
              <ContextMenuShortcut>
                <RotateCwIcon className="size-3.5" />
              </ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      {dialog?.kind === "mkdir" && (
        <NameDialog
          title="新建文件夹"
          action="创建"
          initial=""
          onClose={() => setDialog(null)}
          onSubmit={(name) => api.mkdir(projectId, path, name).then(load)}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={`重命名「${dialog.entry.name}」`}
          action="重命名"
          initial={dialog.entry.name}
          onClose={() => setDialog(null)}
          onSubmit={(name) => api.renameFile(projectId, join(path, dialog.entry.name), name).then(load)}
        />
      )}
      {dialog?.kind === "preview" && (
        <PreviewDialog projectId={projectId} path={join(path, dialog.entry.name)} entry={dialog.entry} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function NameDialog(props: { title: string; action: string; initial: string; onClose: () => void; onSubmit: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState(props.initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await props.onSubmit(name.trim());
      props.onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onFocus={(e) => {
              // 重命名时只选中文件名部分，不选扩展名
              const dot = e.target.value.lastIndexOf(".");
              e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
            }}
            aria-invalid={!!error}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Spinner data-icon="inline-start" />}
              {props.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PreviewDialog(props: { projectId: string; path: string; entry: FileEntry; onClose: () => void }) {
  const { projectId, path, entry } = props;
  const isImage = IMAGE.test(entry.name);
  const [text, setText] = useState<{ text: string; truncated: boolean } | "binary" | null>(null);

  useEffect(() => {
    if (isImage) return;
    api.readText(projectId, path).then((r) => setText("binary" in r ? "binary" : r), fail);
  }, [projectId, path, isImage]);

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{entry.name}</DialogTitle>
          <DialogDescription>{formatSize(entry.size)}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-background">
          {isImage ? (
            <img src={api.rawUrl(projectId, path)} alt={entry.name} className="mx-auto max-h-[60vh] object-contain" />
          ) : text === null ? (
            <div className="flex justify-center p-8">
              <Spinner />
            </div>
          ) : text === "binary" ? (
            <p className="p-8 text-center text-sm text-muted-foreground">这是二进制文件，不能预览，请下载查看。</p>
          ) : (
            <pre className="p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {text.text}
              {text.truncated && <span className="text-muted-foreground">{"\n\n"}…（文件较大，只显示前 512KB，完整内容请下载）</span>}
            </pre>
          )}
        </div>
        <DialogFooter>
          <Button asChild>
            <a href={api.downloadUrl(projectId, path)}>
              <DownloadIcon data-icon="inline-start" />
              下载
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
