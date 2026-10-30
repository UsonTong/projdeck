import type { CcSwitchStatus } from "@projdeck/shared";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";

const host = (url: string | null) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

/**
 * 用 CC Switch 切换 Claude 的供应商（全局：之后新开的 Claude 会话生效）。列表直接点选，不用下拉菜单。
 * 打开时重新读取：可能刚在 CC Switch 里切过。
 */
export function CcSwitchDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: CcSwitchStatus;
  onStatus: (s: CcSwitchStatus) => void;
}) {
  const { status, onStatus } = props;
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    if (props.open) api.ccswitch().then(onStatus, () => undefined);
  }, [props.open, onStatus]);

  const pick = async (id: string) => {
    if (id === status.current || switching) return;
    setSwitching(id);
    try {
      const r = await api.ccswitchClaude(id);
      onStatus(r);
      const name = r.providers.find((p) => p.id === id)?.name ?? id;
      toast.success(`Claude 已切换到 ${name}`, { description: "之后新开的 Claude 会话生效" + (r.restarted ? "，CC Switch 已重启同步" : "") });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSwitching(null);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Claude 供应商</DialogTitle>
          <DialogDescription>
            和在 CC Switch 里切换一样，改的是电脑上的全局配置：之后新开的 Claude 会话生效，正在运行的不受影响。切换时 CC Switch 会自动重启一下以保持同步。
          </DialogDescription>
        </DialogHeader>
        {status.blocked && (
          <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-status-blocked" />
            {status.blocked}
          </div>
        )}
        <div className="-mx-1 flex max-h-[60dvh] flex-col gap-0.5 overflow-y-auto px-1">
          {status.providers.map((p) => {
            const current = p.id === status.current;
            const site = host(p.website);
            return (
              <button
                key={p.id}
                disabled={!!status.blocked || !!switching}
                onClick={() => void pick(p.id)}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent disabled:pointer-events-none",
                  current && "bg-accent",
                  !!status.blocked && !current && "opacity-50",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{p.name}</div>
                  {site && <div className="truncate text-xs text-muted-foreground">{site}</div>}
                </div>
                {switching === p.id ? <Spinner /> : current && <CheckIcon className="size-4 shrink-0" />}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">Codex 的供应商请在 CC Switch 里切换。</p>
      </DialogContent>
    </Dialog>
  );
}
