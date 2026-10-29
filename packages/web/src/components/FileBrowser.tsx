import type { DirListing, FileEntry } from "@projdeck/shared";
import {
  ChevronRightIcon,
  CopyIcon,
  CornerLeftUpIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  type LucideIcon,
  PencilIcon,
  RotateCwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, useTimeZone } from "@/lib/time";
import { formatSize } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { confirmDialog } from "./Confirm.tsx";

const fail = (err: unknown) => toast.error((err as Error).message);
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** 鼠标悬停才出现的操作；触屏设备没有悬停，始终显示。 */
const HOVER_REVEAL = "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100";

function iconFor(e: FileEntry): LucideIcon {
  if (e.type === "dir") return FolderIcon;
  const n = e.name.toLowerCase();
  if (IMAGE.test(n) || n.endsWith(".svg")) return FileImageIcon;
  if (/\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/.test(n)) return FileArchiveIcon;
  if (/\.(md|txt|log|csv|pdf|docx?)$/.test(n)) return FileTextIcon;
  if (/\.(ts|tsx|js|jsx|mjs|py|go|rs|java|c|cc|cpp|h|rb|php|sh|zsh|json|ya?ml|toml|html|css|sql|vue|svelte|kt|swift)$/.test(n)) return FileCodeIcon;
  return FileIcon;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // HTTP 下没有 clipboard API
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast.success("已复制路径", { description: text });
}

function IconButton(props: { label: string; onClick: () => void; children: ReactNode; className?: string; destructive?: boolean; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={props.active ? "secondary" : "ghost"}
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

/**
 * 项目文件管理器（类似 SFTP）：浏览、上传、下载、预览、新建文件夹、重命名、删除。
 * 范围限定在项目目录内（服务端校验，见 agentd/src/files.ts）。
 */
export function FileBrowser(props: {
  projectId: string;
  projectName: string;
  /** 项目绝对路径，用于「复制路径」。 */
  projectPath: string;
  path: string;
  onNavigate: (path: string) => void;
  compact?: boolean;
}) {
  const { projectId, path } = props;
  const timeZone = useTimeZone();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem("projdeck:showHiddenFiles") === "1");
  const [upload, setUpload] = useState<{ names: string; ratio: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: "mkdir" } | { kind: "rename"; entry: FileEntry } | { kind: "preview"; entry: FileEntry }>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setError("");
    api.listDir(projectId, path, showHidden).then(setListing, (err: Error) => {
      setListing(null);
      setError(err.message);
    });
  }, [projectId, path, showHidden]);

  useEffect(load, [load]);

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

  const open = (e: FileEntry) => (e.type === "dir" ? props.onNavigate(join(path, e.name)) : setDialog({ kind: "preview", entry: e }));

  const segments = path ? path.split("/") : [];
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void uploadFiles([...e.dataTransfer.files]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏：路径 + 操作 */}
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-sm [scrollbar-width:none]">
          <button className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-accent" onClick={() => props.onNavigate("")}>
            {props.projectName}
          </button>
          {segments.map((seg, i) => (
            <span key={i} className="flex shrink-0 items-center gap-0.5">
              <ChevronRightIcon className="size-3.5 text-muted-foreground" />
              <button className="rounded px-1.5 py-0.5 hover:bg-accent" onClick={() => props.onNavigate(segments.slice(0, i + 1).join("/"))}>
                {seg}
              </button>
            </span>
          ))}
        </nav>
        <IconButton label={showHidden ? "不显示隐藏文件" : "显示隐藏文件"} active={showHidden} onClick={toggleHidden}>
          {showHidden ? <EyeIcon /> : <EyeOffIcon />}
        </IconButton>
        <IconButton label="新建文件夹" onClick={() => setDialog({ kind: "mkdir" })}>
          <FolderPlusIcon />
        </IconButton>
        <IconButton label="刷新" onClick={load}>
          <RotateCwIcon />
        </IconButton>
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

      {/* 列表，也是拖放上传区域 */}
      <div
        className={cn("relative min-h-0 flex-1 overflow-y-auto p-2", dragging && "bg-accent/40 outline-2 -outline-offset-4 outline-dashed outline-ring")}
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
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-0.5">
            {path && (
              <button className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent/60" onClick={() => props.onNavigate(segments.slice(0, -1).join("/"))}>
                <CornerLeftUpIcon className="size-4" />
                上一级
              </button>
            )}
            {listing.entries.map((e) => {
              const Icon = iconFor(e);
              const rel = join(path, e.name);
              return (
                <div key={e.name} className="group/row relative flex items-center gap-3 rounded-lg px-3 py-1.5 hover:bg-accent/60">
                  <Icon className={cn("size-4 shrink-0", e.type === "dir" ? "text-status-working" : "text-muted-foreground")} />
                  <div className="min-w-0 flex-1">
                    {/* after: 伪元素铺满整行，整行可点 */}
                    <button className="block w-full truncate text-left text-sm after:absolute after:inset-0" onClick={() => open(e)}>
                      {e.name}
                      {e.symlink && <span className="ml-1.5 text-xs text-muted-foreground">↗</span>}
                    </button>
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
                  <div className={cn("relative z-10 flex shrink-0 items-center", HOVER_REVEAL)}>
                    <IconButton label="复制绝对路径" onClick={() => void copyText(`${props.projectPath}/${rel}`)}>
                      <CopyIcon />
                    </IconButton>
                    <IconButton label={e.type === "dir" ? "打包下载（.tar.gz）" : "下载"} onClick={() => (location.href = api.downloadUrl(projectId, rel))}>
                      <DownloadIcon />
                    </IconButton>
                    <IconButton label="重命名" onClick={() => setDialog({ kind: "rename", entry: e })}>
                      <PencilIcon />
                    </IconButton>
                    <IconButton label="删除" destructive onClick={() => void remove(e)}>
                      <Trash2Icon />
                    </IconButton>
                  </div>
                </div>
              );
            })}
            {listing.entries.length === 0 && (
              <Empty className="mt-4">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderIcon />
                  </EmptyMedia>
                  <EmptyTitle>空文件夹</EmptyTitle>
                  <EmptyDescription>点「上传」，或把文件拖到这里。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        )}
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
