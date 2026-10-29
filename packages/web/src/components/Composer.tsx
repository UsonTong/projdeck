import type { SessionKind } from "@projdeck/shared";
import { ArrowUpIcon, FileIcon, PaperclipIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { toast } from "sonner";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatSize, uploadFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";

interface Attachment {
  id: number;
  name: string;
  size: number;
  /** 图片的本地预览地址；非图片为 null。 */
  preview: string | null;
  /** 上传完成后的本地绝对路径；上传中为 null。 */
  path: string | null;
  error?: string;
}

let nextId = 0;

/** 草稿按会话保存，切换会话或刷新页面不丢失。 */
const draftKey = (paneId: string) => `projdeck:draft:${paneId}`;

export function Composer(props: {
  paneId: string;
  projectId: string | null;
  kind: SessionKind;
  /** 宽屏对话视图下与消息列同宽居中。 */
  centered?: boolean;
  onSent?: () => void;
}) {
  const { paneId, projectId, kind } = props;
  const [text, setText] = useState(() => localStorage.getItem(draftKey(paneId)) ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (text) localStorage.setItem(draftKey(paneId), text);
    else localStorage.removeItem(draftKey(paneId));
  }, [paneId, text]);

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    if (!projectId) {
      toast.error("未归属项目的会话不能上传文件，请先导入它所在的文件夹");
      return;
    }
    for (const file of files) {
      const id = nextId++;
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      setAttachments((xs) => [...xs, { id, name: file.name || "file", size: file.size, preview, path: null }]);
      void uploadFile(projectId, file).then(
        ({ path }) => setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, path } : a))),
        (err: Error) => setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, error: err.message } : a))),
      );
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  };

  const remove = (id: number) =>
    setAttachments((xs) => {
      const a = xs.find((x) => x.id === id);
      if (a?.preview) URL.revokeObjectURL(a.preview);
      return xs.filter((x) => x.id !== id);
    });

  const uploading = attachments.some((a) => !a.path && !a.error);
  const ready = attachments.filter((a) => a.path);
  const canSend = !sending && !uploading && (text.trim() !== "" || ready.length > 0);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await api.prompt(paneId, text, ready.map((a) => a.path!));
      setText("");
      attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      setAttachments([]);
      props.onSent?.();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t bg-background px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:px-4 md:pb-4">
      <InputGroup
        className={cn("bg-card transition-colors", props.centered && "mx-auto max-w-3xl", dragging && "border-primary bg-accent")}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {attachments.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap gap-2 pb-0">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} onRemove={() => remove(a.id)} />
            ))}
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          value={text}
          placeholder={kind === "shell" ? "输入命令" : dragging ? "松开以上传" : "输入消息，可粘贴或拖入图片和文件"}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            // 电脑上 Ctrl/⌘+Enter 发送；手机上回车只换行，用发送按钮提交
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          autoCapitalize={kind === "shell" ? "off" : "sentences"}
          autoCorrect={kind === "shell" ? "off" : "on"}
          spellCheck={kind !== "shell"}
          // 16px 以上，iOS 聚焦时不会自动放大页面
          className="max-h-[33vh] min-h-11 text-base md:text-sm"
        />
        <InputGroupAddon align="block-end">
          {kind !== "shell" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <InputGroupButton size="icon-sm" variant="ghost" aria-label="添加附件" disabled={!projectId} onClick={() => fileInput.current?.click()}>
                  <PaperclipIcon />
                </InputGroupButton>
              </TooltipTrigger>
              <TooltipContent>添加图片或文件（最大 50MB）</TooltipContent>
            </Tooltip>
          )}
          <span className="ml-auto hidden text-xs text-muted-foreground md:inline">
            <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> 发送
          </span>
          {/* 手机上没有上面的快捷键提示，ml-auto 让发送按钮始终靠右 */}
          <InputGroupButton size="icon-sm" variant="default" className="ml-auto rounded-full md:ml-0" aria-label="发送" disabled={!canSend} onClick={() => void send()}>
            {sending || uploading ? <Spinner /> : <ArrowUpIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function AttachmentChip({ attachment: a, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const uploading = !a.path && !a.error;
  return (
    <div className="group/chip relative shrink-0" title={a.error ?? a.name}>
      {a.preview ? (
        <img src={a.preview} alt="" className={cn("size-14 rounded-lg border object-cover", uploading && "opacity-40", a.error && "border-destructive opacity-50")} />
      ) : (
        <div className={cn("flex h-14 w-48 items-center gap-2.5 rounded-lg border bg-background px-2.5", a.error && "border-destructive")}>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            {a.error ? <TriangleAlertIcon className="size-4 text-destructive" /> : uploading ? <Spinner /> : <FileIcon className="size-4" />}
          </div>
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium">{a.name}</div>
            <div className="truncate text-muted-foreground">{a.error ?? formatSize(a.size)}</div>
          </div>
        </div>
      )}
      {a.preview && uploading && <Spinner className="absolute inset-0 m-auto size-4" />}
      <button
        onClick={onRemove}
        aria-label="移除附件"
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
