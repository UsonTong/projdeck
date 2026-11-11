import type { Session } from "@projdeck/shared";
import { AArrowDownIcon, AArrowUpIcon, ArchiveIcon, CheckIcon, EllipsisIcon, EyeIcon, EyeOffIcon, HistoryIcon, PencilIcon, SquareIcon, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, useTimeZone } from "@/lib/time";
import { api } from "../api.ts";
import { openSession } from "../router.ts";
import { confirmDialog } from "./Confirm.tsx";

const fail = (err: unknown) => toast.error((err as Error).message);

interface Action {
  key: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  /** 执行后菜单保持打开（如连续调字号）。 */
  keepOpen?: boolean;
}

/**
 * 会话页右上角的操作。不用下拉菜单：
 * 电脑上直接排成图标按钮，手机上点「更多」从底部弹出面板。
 */
export function SessionActions(props: {
  session: Session;
  wide: boolean;
  fontSize: number | null;
  onFontSize: (delta: 1 | -1) => void;
  onRename: () => void;
}) {
  const { session } = props;
  const [sheet, setSheet] = useState(false);
  const [codexPicker, setCodexPicker] = useState(false);

  const archive = async () => {
    if (session.status === "working") {
      const ok = await confirmDialog({
        title: "归档正在工作的会话？",
        description: "归档会立即关闭这个 pane，正在进行的任务会被中断。对话可以之后恢复。",
        action: "归档",
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      await api.archive(session.paneId);
      openSession(null);
    } catch (err) {
      fail(err);
    }
  };

  const actions: Action[] = [];
  if (props.fontSize !== null) {
    actions.push(
      { key: "font-", label: `缩小字号（${props.fontSize}）`, icon: AArrowDownIcon, run: () => props.onFontSize(-1), keepOpen: true },
      { key: "font+", label: `放大字号（${props.fontSize}）`, icon: AArrowUpIcon, run: () => props.onFontSize(1), keepOpen: true },
    );
  }
  actions.push({ key: "rename", label: "重命名", icon: PencilIcon, run: props.onRename });
  actions.push({
    key: "hide",
    label: session.hidden ? "取消隐藏" : "隐藏",
    icon: session.hidden ? EyeIcon : EyeOffIcon,
    run: () => void api.setHidden(session.paneId, !session.hidden).catch(fail),
  });
  if (session.kind === "harness" && session.status === "working") {
    actions.push({ key: "cancel", label: "停止生成", icon: SquareIcon, run: () => void api.cancel(session.paneId).catch(fail) });
  }
  if (session.kind === "codex") actions.push({ key: "codex", label: "选择对话记录", icon: HistoryIcon, run: () => setCodexPicker(true) });
  if (session.kind !== "shell") {
    actions.push({ key: "archive", label: session.kind === "harness" ? "归档（保留 Harness 对话）" : "归档（关闭 pane，保留对话）", icon: ArchiveIcon, run: () => void archive() });
  }

  return (
    <>
      {props.wide ? (
        // 电脑端也收进「更多」菜单，不再一排七八个图标挤在标题栏
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="更多操作">
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {actions.map((a, i) => (
              <Fragment key={a.key}>
                {i > 0 && i === actions.length - 1 && <DropdownMenuSeparator />}
                <DropdownMenuItem variant={a.key === "archive" ? "destructive" : "default"} onSelect={a.run}>
                  <a.icon />
                  {a.label}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button variant="ghost" size="icon" aria-label="更多操作" onClick={() => setSheet(true)}>
          <EllipsisIcon />
        </Button>
      )}

      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <SheetHeader>
            <SheetTitle className="truncate">{session.title}</SheetTitle>
            <SheetDescription className="truncate font-mono text-xs">{session.cwd}</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-1 px-4">
            {actions.map((a) => (
              <Button
                key={a.key}
                variant="ghost"
                size="lg"
                className="h-12 justify-start gap-3 text-base"
                onClick={() => {
                  a.run();
                  if (!a.keepOpen) setSheet(false);
                }}
              >
                <a.icon className="size-5" />
                {a.label}
              </Button>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {session.kind === "codex" && <CodexConversationDialog session={session} open={codexPicker} onOpenChange={setCodexPicker} />}
    </>
  );
}

/** 同一目录下有多个 Codex 时自动匹配可能出错，这里手动指定对话记录。 */
function CodexConversationDialog(props: { session: Session; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { session } = props;
  const [candidates, setCandidates] = useState<{ threadId: string; modifiedAt: string }[] | null>(null);
  const timeZone = useTimeZone();

  useEffect(() => {
    if (!props.open) return;
    setCandidates(null);
    api.codexCandidates(session.paneId).then(setCandidates, fail);
  }, [props.open, session.paneId]);

  const choose = (threadId: string | null) =>
    void api.setCodexConversation(session.paneId, threadId).then(() => props.onOpenChange(false), fail);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>选择对话记录</DialogTitle>
          <DialogDescription>同一目录下同时开了多个 Codex 时，自动匹配可能出错，可以在这里手动指定。</DialogDescription>
        </DialogHeader>
        {candidates === null ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : candidates.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">该目录下没有最近的 Codex 对话</p>
        ) : (
          <ItemGroup className="max-h-80 gap-1.5 overflow-y-auto">
            {candidates.map((c) => (
              <Item key={c.threadId} variant="outline" size="sm" asChild>
                <button onClick={() => choose(c.threadId)}>
                  <ItemContent>
                    <ItemTitle>{formatDateTime(c.modifiedAt, timeZone)}</ItemTitle>
                    <ItemDescription className="font-mono text-xs">{c.threadId}</ItemDescription>
                  </ItemContent>
                  {c.threadId === session.conversationId && (
                    <ItemActions>
                      <CheckIcon className="size-4" />
                    </ItemActions>
                  )}
                </button>
              </Item>
            ))}
          </ItemGroup>
        )}
        <Button variant="outline" onClick={() => choose(null)}>
          恢复自动匹配
        </Button>
      </DialogContent>
    </Dialog>
  );
}
