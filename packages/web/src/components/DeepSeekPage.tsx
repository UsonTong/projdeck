import type { Session } from "@projdeck/shared";
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { formatDateTime, useTimeZone } from "@/lib/time";
import { useLive } from "../live.ts";
import { openSession } from "../router.ts";
import { AgentIcon } from "./AgentIcon.tsx";
import { HarnessSettings } from "./HarnessSettings.tsx";

/**
 * 所有 DeepSeek 对话的总览，不按项目分组。标题是空会话时明确标出，
 * 有对话的排在前面，解决「在一堆同名空会话里找不到历史」的问题。
 */
export function DeepSeekPage() {
  const { overview } = useLive();
  const timeZone = useTimeZone();
  const sessions = useMemo(() => {
    if (!overview) return [];
    return [...overview.projects.flatMap((p) => p.sessions), ...overview.unassigned]
      .filter((s) => s.kind === "harness")
      .sort((a, b) => Number(a.title.startsWith("空会话")) - Number(b.title.startsWith("空会话")) || (b.activeAt ?? 0) - (a.activeAt ?? 0));
  }, [overview]);
  const projectOf = (s: Session) =>
    overview?.projects.find((p) => p.sessions.some((x) => x.paneId === s.paneId))?.name ?? "未归属";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={() => openSession(null)}><ArrowLeftIcon /></Button>
        <AgentIcon kind="harness" size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">DeepSeek 对话</div>
          <div className="truncate text-xs text-muted-foreground">{sessions.length} 个会话</div>
        </div>
        {overview?.harness?.configured && (
          <Button variant="outline" size="sm" asChild>
            <a href="/harness/" target="_blank" rel="noreferrer" title="在新标签页打开完整的 DeepSeek Harness（含原版侧栏）">
              <ExternalLinkIcon data-icon="inline-start" />
              完整 DSH
            </a>
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!overview?.harness?.configured ? (
          <div className="mx-auto w-full max-w-lg p-4"><HarnessSettings /></div>
        ) : sessions.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">还没有 DeepSeek 对话。在项目旁点 agent 按钮，选择 DeepSeek 新建。</p>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-1">
            {sessions.map((s) => {
              const blank = s.title.startsWith("空会话");
              return (
                <button
                  key={s.paneId}
                  onClick={() => openSession(s.paneId)}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/60"
                >
                  <AgentIcon kind="harness" size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${blank ? "text-muted-foreground" : "font-medium"}`}>{s.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {projectOf(s)} · {s.cwd}
                      {s.activeAt ? ` · ${formatDateTime(new Date(s.activeAt).toISOString(), timeZone)}` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
