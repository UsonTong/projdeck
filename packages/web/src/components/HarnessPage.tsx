import { ArrowLeftIcon, ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { useLive } from "../live.ts";
import { openSession } from "../router.ts";
import { HarnessSettings } from "./HarnessSettings.tsx";

/** 不再重绘聊天：直接运行现有 Harness 的完整原版前端，会话由它自己的侧栏管理。 */
export function HarnessPage() {
  const { overview } = useLive();
  const frame = useRef<HTMLIFrameElement>(null);
  const state = overview?.harness;
  const ready = state?.configured && (state.online || !state.error);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-2 pt-[calc(0.4rem+env(safe-area-inset-top))] pb-1.5">
        <Button variant="ghost" size="icon-sm" aria-label="返回 projdeck" onClick={() => openSession(null)}><ArrowLeftIcon /></Button>
        <span className="flex-1 text-sm font-medium">DeepSeek Harness</span>
        <Button variant="ghost" size="icon-sm" aria-label="刷新 Harness" onClick={() => frame.current?.contentWindow?.location.reload()}><RotateCwIcon /></Button>
        {ready && (
          <Button variant="ghost" size="icon-sm" aria-label="单独打开 Harness" asChild>
            <a href="/harness/" target="_blank" rel="noreferrer"><ExternalLinkIcon /></a>
          </Button>
        )}
      </header>
      {ready ? (
        <iframe ref={frame} src="/harness/" title="DeepSeek Harness 原版网页" allow="clipboard-read; clipboard-write; fullscreen" className="min-h-0 w-full flex-1 border-0 bg-background" />
      ) : (
        <div className="mx-auto w-full max-w-lg p-4"><HarnessSettings /></div>
      )}
    </div>
  );
}
