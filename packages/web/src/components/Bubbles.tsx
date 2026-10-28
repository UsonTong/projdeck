import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useMemo, useState } from "react";
import type { TranscriptEntry } from "@projdeck/shared";
import { api } from "../api.ts";
import { useStickToBottom } from "./useStickToBottom.ts";

/** 只渲染最近这么多条，长会话也不卡。 */
const MAX_ENTRIES = 300;

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
type Item = TranscriptEntry | { kind: "tools"; id: string; tools: ToolEntry[] };

/** 连续的工具调用合并成一行，点开再看明细。 */
function group(entries: TranscriptEntry[]): Item[] {
  const items: Item[] = [];
  for (const e of entries.slice(-MAX_ENTRIES)) {
    const last = items[items.length - 1];
    if (e.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(e);
      else items.push({ kind: "tools", id: e.id, tools: [e] });
    } else items.push(e);
  }
  return items;
}

export function Bubbles(props: { entries: TranscriptEntry[]; projectId: string | null; conversationId: string | null }) {
  const items = useMemo(() => group(props.entries), [props.entries]);
  const ref = useStickToBottom<HTMLDivElement>(items);

  if (!props.conversationId) {
    return <div className="bubbles empty">还没有对话记录。发一条消息后会显示在这里，也可以切到「终端」查看。</div>;
  }

  return (
    <div className="bubbles" ref={ref}>
      {props.entries.length > MAX_ENTRIES && <div className="hint center">只显示最近 {MAX_ENTRIES} 条</div>}
      {items.map((item) =>
        item.kind === "tools" ? (
          <ToolGroup key={item.id} tools={item.tools} />
        ) : item.kind === "user" ? (
          <div key={item.id} className="bubble user">
            {item.text && <div className="text">{item.text}</div>}
            {item.images.length > 0 && (
              <div className="images">
                {item.images.map((p) =>
                  props.projectId ? (
                    <a key={p} href={api.fileUrl(props.projectId, p)} target="_blank" rel="noreferrer">
                      <img src={api.fileUrl(props.projectId, p)} alt="" loading="lazy" />
                    </a>
                  ) : (
                    <span key={p} className="row-sub">
                      [图片] {p}
                    </span>
                  ),
                )}
              </div>
            )}
          </div>
        ) : item.kind === "assistant" ? (
          <Markdown key={item.id} text={item.text} />
        ) : null,
      )}
    </div>
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true })), [text]);
  return <div className="bubble assistant markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});

function ToolGroup({ tools }: { tools: ToolEntry[] }) {
  const [open, setOpen] = useState(false);
  const last = tools[tools.length - 1]!;
  return (
    <div className="tools">
      <button className="tools-head" onClick={() => setOpen(!open)}>
        <span className="tool-name">{last.name}</span>
        <span className="tool-summary">{last.summary}</span>
        {tools.length > 1 && <span className="count">+{tools.length - 1}</span>}
      </button>
      {open && (
        <ul>
          {tools.map((t) => (
            <li key={t.id}>
              <span className="tool-name">{t.name}</span> {t.summary}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
