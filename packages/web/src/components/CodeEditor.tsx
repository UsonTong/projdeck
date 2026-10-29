import { ArrowLeftIcon, RotateCwIcon, SaveIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applyEditorTheme, monaco } from "@/lib/monaco";
import { useTerminalTheme } from "@/lib/terminalTheme";
import { api, ApiError } from "../api.ts";
import { useWide } from "../live.ts";
import { confirmDialog } from "./Confirm.tsx";

/** 与终端一致的字体：Ghostty 配置的字体 → 内置 JetBrains Mono → 中文。 */
const fontStack = (families: string[]) =>
  [...families.map((f) => `"${f}"`), '"projdeck JetBrains Mono"', '"Noto Sans Mono CJK SC"', '"PingFang SC"', "monospace"].join(", ");

/**
 * 文件编辑器（VS Code 的 Monaco），用于简单修改：Ctrl+S 保存，查找替换、多光标等快捷键与 VS Code 一致。
 * 保存时检查文件在打开之后有没有被改过（agent 可能同时在改），被改过就让用户决定是否覆盖。
 */
export default function CodeEditor(props: { projectId: string; path: string; onClose: () => void }) {
  const { projectId, path } = props;
  const theme = useTerminalTheme();
  const wide = useWide();
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const state = useRef({ baseMtimeMs: 0, savedVersion: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const markSaved = (model: monaco.editor.ITextModel, mtimeMs: number) => {
    state.current = { baseMtimeMs: mtimeMs, savedVersion: model.getAlternativeVersionId() };
    setDirty(false);
  };

  const save = async (force = false): Promise<void> => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    setSaving(true);
    try {
      const r = await api.saveFile(projectId, path, model.getValue(), force ? null : state.current.baseMtimeMs);
      markSaved(model, r.mtimeMs);
      toast.success("已保存");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const ok = await confirmDialog({
          title: "文件在你打开之后被改过",
          description: "可能是 Claude / Codex 刚改了它。覆盖保存会丢掉对方的修改；也可以先取消，点「重新加载」看最新内容。",
          action: "覆盖保存",
          destructive: true,
        });
        if (ok) return save(true);
      } else toast.error((err as Error).message);
    } finally {
      setSaving(false);
      // 点了按钮或确认框之后焦点不在编辑器里，还给它，Ctrl+F 等快捷键才能继续用
      editorRef.current?.focus();
    }
  };

  const reload = async () => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (dirtyRef.current && !(await confirmDialog({ title: "放弃你的修改，重新加载？", description: "未保存的修改会丢失。", action: "重新加载", destructive: true })))
      return;
    try {
      const r = await api.readForEdit(projectId, path);
      model.setValue(r.text);
      markSaved(model, r.mtimeMs);
    } catch (err) {
      toast.error((err as Error).message);
    }
    editorRef.current?.focus();
  };

  const close = async () => {
    if (dirtyRef.current && !(await confirmDialog({ title: "放弃未保存的修改？", description: "关闭后修改会丢失。", action: "放弃", destructive: true })))
      return;
    props.onClose();
  };

  // 打开文件：创建编辑器和模型（按扩展名识别语言）
  useEffect(() => {
    let disposed = false;
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    let model: monaco.editor.ITextModel | null = null;
    api.readForEdit(projectId, path).then(
      (r) => {
        if (disposed || !host.current) return;
        model = monaco.editor.createModel(r.text, undefined, monaco.Uri.parse(`file:///${projectId}/${path}`));
        editor = monaco.editor.create(host.current, {
          model,
          theme: "projdeck",
          automaticLayout: true,
          fontFamily: fontStack(theme?.fontFamily ?? []),
          fontSize: wide ? 14 : 13,
          minimap: { enabled: wide },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorSmoothCaretAnimation: "on",
          fixedOverflowWidgets: true,
          // 「易混淆字符」会把不少中文（如「二」像等号）标上底色，中文注释和字符串满屏灰块
          unicodeHighlight: { ambiguousCharacters: false },
          padding: { top: 8 },
        });
        editorRef.current = editor;
        markSaved(model, r.mtimeMs);
        model.onDidChangeContent(() => setDirty(model!.getAlternativeVersionId() !== state.current.savedVersion));
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
        editor.focus();
        setLoading(false);
      },
      (err: Error) => {
        setError(err.message);
        setLoading(false);
      },
    );
    return () => {
      disposed = true;
      editor?.dispose();
      model?.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换文件时重建
  }, [projectId, path]);

  // 配色跟随 Ghostty 主题
  useEffect(() => {
    if (theme) applyEditorTheme(theme);
  }, [theme]);

  // 有未保存的修改时，关闭标签页前浏览器会提示
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => dirtyRef.current && e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const name = path.split("/").pop();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="返回文件列表" onClick={() => void close()}>
              <ArrowLeftIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>返回文件列表</TooltipContent>
        </Tooltip>
        <div className="min-w-0 flex-1 px-1">
          <div className="flex items-center gap-1.5 truncate text-sm font-medium">
            {name}
            {dirty && <span className="size-2 shrink-0 rounded-full bg-foreground/70" aria-label="未保存" />}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{path}</div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="重新加载" disabled={loading || !!error} onClick={() => void reload()}>
              <RotateCwIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>从磁盘重新加载</TooltipContent>
        </Tooltip>
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
          保存
          <span className="text-xs opacity-60 max-sm:hidden">Ctrl+S</span>
        </Button>
      </div>
      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={() => (location.href = api.downloadUrl(projectId, path))}>
            下载文件
          </Button>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <div ref={host} className="absolute inset-0" />
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner className="size-5" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
