import type { AgentKind, Session, TranscriptEntry } from "@projdeck/shared";
import {
  ArrowDownIcon,
  BotIcon,
  FileIcon,
  FilePenIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  MessagesSquareIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { formatMessageTime, useTimeZone } from "@/lib/time";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { AgentIcon } from "./AgentIcon.tsx";
import { Markdown } from "./Markdown.tsx";
import { useStickToBottom } from "./useStickToBottom.ts";

/** 只渲染最近这么多条，长会话也不卡。 */
const MAX_ENTRIES = 300;

type UserEntry = Extract<TranscriptEntry, { kind: "user" }>;
type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
type Part = { kind: "text"; id: string; text: string } | { kind: "tools"; id: string; tools: ToolEntry[] };
type Block = { kind: "user"; entry: UserEntry; files: string[] } | { kind: "turn"; id: string; time?: string; parts: Part[] };

/** 消息里引用的上传文件（项目/.uploads/ 下的绝对路径），从正文中抽出来单独显示。 */
const UPLOAD_PATH = /(?:^|\s)(\/\S+\/\.uploads\/\S+)/g;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** 把扁平的会话记录整理成：用户消息 + 一轮轮的助手回复（连续的文本与工具调用合为一轮）。 */
function toBlocks(entries: TranscriptEntry[]): Block[] {
  const blocks: Block[] = [];
  for (const e of entries.slice(-MAX_ENTRIES)) {
    if (e.kind === "user") {
      const files = [...e.text.matchAll(UPLOAD_PATH)].map((m) => m[1]!);
      const text = e.text.replace(UPLOAD_PATH, "").trim();
      const images = [...e.images, ...files.filter((f) => IMAGE_EXT.test(f) && !e.images.includes(f))];
      blocks.push({ kind: "user", entry: { ...e, text, images }, files: files.filter((f) => !IMAGE_EXT.test(f)) });
      continue;
    }
    let turn = blocks[blocks.length - 1];
    if (turn?.kind !== "turn") {
      turn = { kind: "turn", id: e.id, time: e.time, parts: [] };
      blocks.push(turn);
    }
    const last = turn.parts[turn.parts.length - 1];
    if (e.kind === "assistant") turn.parts.push({ kind: "text", id: e.id, text: e.text });
    else if (last?.kind === "tools") last.tools.push(e);
    else turn.parts.push({ kind: "tools", id: e.id, tools: [e] });
  }
  return blocks;
}


const AGENT_NAME: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", pi: "Pi" };

export function Bubbles(props: {
  entries: TranscriptEntry[];
  projectId: string | null;
  conversationId: string | null;
  agent: AgentKind;
  status: Session["status"];
}) {
  const blocks = useMemo(() => toBlocks(props.entries), [props.entries]);
  // 第一次拿到对话之后新出现的消息淡入上浮；刚打开时已有的那一大批不动
  const seen = useRef<Set<string> | null>(null);
  const isNew = (id: string) => seen.current !== null && !seen.current.has(id);
  useEffect(() => {
    if (blocks.length === 0) return;
    seen.current = new Set(blocks.map((b) => (b.kind === "user" ? b.entry.id : b.id)));
  }, [blocks]);
  const working = props.status === "working";
  const { ref, atBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>([blocks, working]);

  if (!props.conversationId) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessagesSquareIcon />
          </EmptyMedia>
          <EmptyTitle>还没有对话记录</EmptyTitle>
          <EmptyDescription>发一条消息后会显示在这里，也可以切到「终端」直接操作。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-6 md:px-6 md:py-8">
          {props.entries.length > MAX_ENTRIES && (
            <p className="text-center text-xs text-muted-foreground">只显示最近 {MAX_ENTRIES} 条</p>
          )}
          {blocks.map((b) =>
            b.kind === "user" ? (
              <div key={b.entry.id} className={isNew(b.entry.id) ? "flex flex-col motion-rise" : "flex flex-col"}>
                <UserMessage entry={b.entry} files={b.files} projectId={props.projectId} />
              </div>
            ) : (
              <div key={b.id} className={isNew(b.id) ? "flex flex-col motion-rise" : "flex flex-col"}>
                <AssistantTurn agent={props.agent} time={b.time} parts={b.parts} />
              </div>
            ),
          )}
          {working && <Thinking agent={props.agent} />}
        </div>
      </div>
      {!atBottom && (
        <Button
          variant="secondary"
          size="icon"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border shadow-lg"
          aria-label="回到底部"
          onClick={scrollToBottom}
        >
          <ArrowDownIcon />
        </Button>
      )}
    </div>
  );
}

function AgentAvatar({ agent }: { agent: AgentKind }) {
  return <AgentIcon kind={agent} size="sm" className="mt-px" />;
}

function UserMessage({ entry, files, projectId }: { entry: UserEntry; files: string[]; projectId: string | null }) {
  const timeZone = useTimeZone();
  return (
    <div className="flex flex-col items-end gap-2">
      {entry.images.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {entry.images.map((p) =>
            projectId ? (
              <a key={p} href={api.fileUrl(projectId, p)} target="_blank" rel="noreferrer" className="overflow-hidden rounded-xl border">
                <img src={api.fileUrl(projectId, p)} alt="" loading="lazy" className="max-h-48 max-w-56 object-cover" />
              </a>
            ) : (
              <FileChip key={p} path={p} />
            ),
          )}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {files.map((p) => (
            <FileChip key={p} path={p} />
          ))}
        </div>
      )}
      {entry.text && (
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {entry.text}
        </div>
      )}
      {entry.time && <span className="px-1 text-[11px] text-muted-foreground tabular-nums">{formatMessageTime(entry.time, timeZone)}</span>}
    </div>
  );
}

/** 上传的文件以「时间-随机-原名」保存，显示时去掉前缀。 */
function FileChip({ path }: { path: string }) {
  const name = path.split("/").pop()!.replace(/^\d{8}-\d{6}-[0-9a-f]{4}-/, "");
  return (
    <div className="flex max-w-64 items-center gap-2.5 rounded-xl border bg-card px-3 py-2" title={path}>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <FileIcon className="size-4" />
      </div>
      <span className="truncate text-sm">{name}</span>
    </div>
  );
}

function AssistantTurn({ agent, time, parts }: { agent: AgentKind; time?: string; parts: Part[] }) {
  const timeZone = useTimeZone();
  return (
    <div className="flex gap-3">
      <AgentAvatar agent={agent} />
      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-0.5">
        <div className="flex items-baseline gap-2 leading-6">
          <span className="text-sm font-medium">{AGENT_NAME[agent]}</span>
          {time && <span className="text-[11px] text-muted-foreground tabular-nums">{formatMessageTime(time, timeZone)}</span>}
        </div>
        {parts.map((p) => (p.kind === "text" ? <Markdown key={p.id} text={p.text} /> : <ToolGroup key={p.id} tools={p.tools} />))}
      </div>
    </div>
  );
}

function Thinking({ agent }: { agent: AgentKind }) {
  return (
    <div className="flex items-center gap-3">
      <AgentAvatar agent={agent} />
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        工作中
        <span className="flex gap-1">
          {[0, 150, 300].map((d) => (
            <span key={d} className="size-1 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${d}ms` }} />
          ))}
        </span>
      </div>
    </div>
  );
}

/** 按工具名选图标（Claude Code 与 Codex 的常见工具）。 */
function toolIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (/bash|shell|exec|command|run/.test(n)) return SquareTerminalIcon;
  if (/^read|view|cat/.test(n)) return FileTextIcon;
  if (/edit|write|patch|notebook/.test(n)) return FilePenIcon;
  if (/grep|glob|search|find|ls/.test(n)) return SearchIcon;
  if (/web|fetch|browse|url/.test(n)) return GlobeIcon;
  if (/todo|plan/.test(n)) return ListTodoIcon;
  if (/task|agent/.test(n)) return BotIcon;
  return WrenchIcon;
}

function ToolRow({ tool }: { tool: ToolEntry }) {
  const Icon = toolIcon(tool.name);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium text-foreground/80">{tool.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{tool.summary}</span>
    </div>
  );
}

/** 工具调用全部内联显示（与 Claude Code 终端里一致），不做折叠。 */
function ToolGroup({ tools }: { tools: ToolEntry[] }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      {tools.map((t) => (
        <ToolRow key={t.id} tool={t} />
      ))}
    </div>
  );
}
