import { ArrowLeftIcon, ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useLive } from "../live.ts";
import { openSession } from "../router.ts";
import { HarnessSettings } from "./HarnessSettings.tsx";

/**
 * projdeck 负责左侧导航，右侧仍运行 Harness 原版聊天；只通过消息桥传递会话 ID。
 * 原版前端启动要一两秒，所以这个页面挂上后常驻（active 为假时隐藏），之后切换会话只是在里面换。
 * 切换期间用不透明的遮罩盖住，目标会话的历史渲染好（嵌入脚本发来 shown）后再淡出。
 */
export function HarnessPage({ sessionId, active = true }: { sessionId?: string; active?: boolean }) {
  const live = useLive();
  const overview = live.overview;
  const frame = useRef<HTMLIFrameElement>(null);
  const target = useRef(sessionId);
  target.current = sessionId;
  const command = useRef(0);
  const bridgeReady = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const send = useRef<() => void>(() => {});
  /** iframe 里当前已经显示好的会话：再次显示同一个时不遮。 */
  const shown = useRef<string | null | undefined>(undefined);
  const activeRef = useRef(active);
  activeRef.current = active;
  // DSH 会话不走 BubblesView 的 usePane，这里补上 watch：真正打开（active）时标记已读
  useEffect(() => {
    if (!sessionId || !active) return;
    return live.watch(`harness:${sessionId}`);
  }, [live, sessionId, active]);
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
    if (!activeRef.current || !bridgeReady.current || !frame.current?.contentWindow) return;
    clearTimeout(timeout.current);
    setError("");
    if ((target.current ?? null) === shown.current) setOpening(false);
    else setOpening(true);
    frame.current.contentWindow.postMessage({ channel: "projdeck-harness", type: "select", sessionId: target.current ?? null, commandId: ++command.current }, location.origin);
    timeout.current = setTimeout(() => setError("Harness 会话联动超时，可刷新或单独打开原版网页。"), 20_000);
  };
  useEffect(() => {
    const receive = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow || e.data?.channel !== "projdeck-harness") return;
      if (e.data.type === "ready") {
        bridgeReady.current = true;
        send.current();
      } else if (e.data.type === "shown" && e.data.commandId === command.current) {
        clearTimeout(timeout.current);
        shown.current = typeof e.data.sessionId === "string" ? e.data.sessionId : null;
        setOpening(false);
        setError("");
      } else if (e.data.type === "selected" && e.data.commandId === command.current) {
        setError("");
        const id = e.data.sessionId;
        // 在原版界面里自己换了会话（例如新建对话）：projdeck 跟过去，画面已经是它，不用再遮
        if (typeof id === "string" && id && id.length <= 512 && id !== target.current) {
          shown.current = id;
          openSession(`harness:${id}`);
        }
      } else if (e.data.type === "error" && (e.data.commandId === undefined || e.data.commandId === command.current)) {
        clearTimeout(timeout.current);
        setError("无法联动此 Harness 会话，可刷新或单独打开原版网页。");
      }
    };
    window.addEventListener("message", receive);
    return () => { window.removeEventListener("message", receive); clearTimeout(timeout.current); };
  }, []);
  useEffect(() => { send.current(); }, [sessionId, active]);
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
    shown.current = undefined;
    setOpening(true);
    setError("");
    frame.current?.contentWindow?.location.replace(embedUrl(target.current));
  };
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !active && "hidden")}>
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
          <div
            role="status"
            aria-hidden={!opening && !error}
            className={cn(
              "absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background p-4 text-sm text-muted-foreground transition-opacity",
              // 盖上是瞬间的，揭开时淡出
              opening || error ? "opacity-100 duration-0" : "pointer-events-none opacity-0 duration-300 ease-out",
            )}
          >
            {error ? (
              <span>{error}</span>
            ) : (
              opening && (
                <span className="motion-delayed flex items-center gap-2">
                  <Spinner />
                  正在打开 Harness 会话…
                </span>
              )
            )}
          </div>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-lg p-4"><HarnessSettings /></div>
      )}
    </div>
  );
}
