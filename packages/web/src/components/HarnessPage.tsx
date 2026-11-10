import { ArrowLeftIcon, ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useLive } from "../live.ts";
import { openSession } from "../router.ts";
import { HarnessSettings } from "./HarnessSettings.tsx";

/** projdeck 负责左侧导航，右侧仍运行 Harness 原版聊天；只通过消息桥传递会话 ID。 */
export function HarnessPage({ sessionId }: { sessionId?: string }) {
  const { overview } = useLive();
  const frame = useRef<HTMLIFrameElement>(null);
  const target = useRef(sessionId);
  target.current = sessionId;
  const command = useRef(0);
  const bridgeReady = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const send = useRef<() => void>(() => {});
  const [opening, setOpening] = useState(true);
  // 首次加载就带上目标会话：嵌入脚本在原版启动前写入它记住的选中项，原版不会先恢复成上次看的会话
  const embedUrl = (id?: string) => `/harness/?embed=1${id ? `&session=${encodeURIComponent(id)}` : ""}`;
  const [src] = useState(() => embedUrl(sessionId));
  const [error, setError] = useState("");
  const state = overview?.harness;
  const ready = state?.configured && (state.online || !state.error);
  const selected = [...(overview?.projects.flatMap((p) => p.sessions) ?? []), ...(overview?.unassigned ?? [])]
    .find((s) => s.kind === "harness" && s.conversationId === sessionId);

  send.current = () => {
    if (!bridgeReady.current || !frame.current?.contentWindow) return;
    clearTimeout(timeout.current);
    setOpening(true);
    setError("");
    frame.current.contentWindow.postMessage({ channel: "projdeck-harness", type: "select", sessionId: target.current ?? null, commandId: ++command.current }, location.origin);
    timeout.current = setTimeout(() => setError("Harness 会话联动超时，可刷新或单独打开原版网页。"), 20_000);
  };
  useEffect(() => {
    const receive = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow || e.data?.channel !== "projdeck-harness") return;
      if (e.data.type === "ready") {
        bridgeReady.current = true;
        send.current();
      } else if (e.data.type === "selected" && e.data.commandId === command.current) {
        clearTimeout(timeout.current);
        setOpening(false);
        setError("");
        const id = e.data.sessionId;
        if (typeof id === "string" && id && id.length <= 512 && id !== target.current) openSession(`harness:${id}`);
      } else if (e.data.type === "error" && (e.data.commandId === undefined || e.data.commandId === command.current)) {
        clearTimeout(timeout.current);
        setError("无法联动此 Harness 会话，可刷新或单独打开原版网页。");
      }
    };
    window.addEventListener("message", receive);
    return () => { window.removeEventListener("message", receive); clearTimeout(timeout.current); };
  }, []);
  useEffect(() => { send.current(); }, [sessionId]);
  useEffect(() => {
    if (!ready) { bridgeReady.current = false; clearTimeout(timeout.current); }
  }, [ready]);
  const loaded = () => {
    if (bridgeReady.current) return;
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setError("此 Harness 页面未提供会话联动，可单独打开原版网页。"), 20_000);
  };
  const reload = () => {
    bridgeReady.current = false;
    setOpening(true);
    setError("");
    frame.current?.contentWindow?.location.replace(embedUrl(target.current));
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-2 pt-[calc(0.4rem+env(safe-area-inset-top))] pb-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="返回 projdeck" onClick={() => openSession(null)}><ArrowLeftIcon /></Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{selected?.title ?? "DeepSeek Harness"}</span>
        <Button variant="ghost" size="icon-sm" aria-label="刷新 Harness" onClick={reload}><RotateCwIcon /></Button>
        {ready && (
          <Button variant="ghost" size="icon-sm" aria-label="单独打开 Harness" asChild>
            <a href="/harness/" target="_blank" rel="noreferrer"><ExternalLinkIcon /></a>
          </Button>
        )}
      </header>
      {ready ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <iframe ref={frame} src={src} onLoad={loaded} title="DeepSeek Harness 原版聊天" allow="clipboard-read; clipboard-write; fullscreen" className="min-h-0 w-full flex-1 border-0 bg-background" />
          {(opening || error) && (
            <div role="status" className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/95 p-4 text-sm text-muted-foreground">
              {error ? <span>{error}</span> : <><Spinner />正在打开 Harness 会话…</>}
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto w-full max-w-lg p-4"><HarnessSettings /></div>
      )}
    </div>
  );
}
