import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import type { SessionKind } from "@projdeck/shared";
import { api } from "../api.ts";
import { prepareImage } from "../image.ts";
import { useToast } from "./Toast.tsx";

interface Attachment {
  id: number;
  preview: string;
  /** 上传完成后的本地绝对路径；上传中为 null。 */
  path: string | null;
  error?: string;
}

let nextId = 0;

/** 草稿按会话保存，切换会话或刷新页面不丢失。 */
const draftKey = (paneId: string) => `projdeck:draft:${paneId}`;

export function Composer(props: { paneId: string; projectId: string | null; kind: SessionKind; onSent?: () => void }) {
  const { paneId, projectId, kind } = props;
  const [text, setText] = useState(() => localStorage.getItem(draftKey(paneId)) ?? "");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (text) localStorage.setItem(draftKey(paneId), text);
    else localStorage.removeItem(draftKey(paneId));
  }, [paneId, text]);

  // 输入框随内容长高，最多到屏幕三分之一
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight / 3)}px`;
  }, [text]);

  const addFiles = (files: File[]) => {
    if (!projectId) {
      toast("未归属项目的会话不能发图，请先导入它所在的文件夹");
      return;
    }
    for (const file of files.filter((f) => f.type.startsWith("image/"))) {
      const id = nextId++;
      setAttachments((xs) => [...xs, { id, preview: URL.createObjectURL(file), path: null }]);
      void (async () => {
        try {
          const { blob, name } = await prepareImage(file);
          const { path } = await api.upload(projectId, blob, name);
          setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, path } : a)));
        } catch (err) {
          setAttachments((xs) => xs.map((a) => (a.id === id ? { ...a, error: (err as Error).message } : a)));
        }
      })();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  };

  const remove = (id: number) =>
    setAttachments((xs) => {
      const a = xs.find((x) => x.id === id);
      if (a) URL.revokeObjectURL(a.preview);
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
      attachments.forEach((a) => URL.revokeObjectURL(a.preview));
      setAttachments([]);
      props.onSent?.();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <div key={a.id} className={`attachment ${a.error ? "failed" : a.path ? "" : "uploading"}`} title={a.error ?? a.path ?? "上传中"}>
              <img src={a.preview} alt="" />
              <button onClick={() => remove(a.id)} aria-label="移除">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        {kind !== "shell" && (
          <button className="ghost icon attach" onClick={() => fileInput.current?.click()} aria-label="添加图片" disabled={!projectId}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <circle cx="9" cy="10" r="1.8" />
              <path d="m21 16-5-5-9 9" />
            </svg>
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <textarea
          ref={textarea}
          rows={1}
          value={text}
          placeholder={kind === "shell" ? "输入命令" : "输入消息，可粘贴图片"}
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
        />
        <button className="primary icon send" onClick={() => void send()} disabled={!canSend} aria-label="发送">
          {sending || uploading ? "…" : "➤"}
        </button>
      </div>
    </div>
  );
}
