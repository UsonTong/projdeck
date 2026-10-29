import { CheckIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { allTimeZones, COMMON_TIME_ZONES, deviceTimeZone, formatDateTime, utcOffset } from "@/lib/time";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { useLive } from "../live.ts";

interface Option {
  /** null = 跟随设备。 */
  zone: string | null;
  title: string;
  description: string;
}

/** 设置：自动信任文件夹、时区。时区用可搜索的列表直接选，不用下拉菜单。 */
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { overview } = useLive();
  const current = overview?.settings.timeZone ?? null;
  const autoTrust = overview?.settings.autoTrust ?? true;
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, [open]);

  const options = useMemo<Option[]>(() => {
    const device = deviceTimeZone();
    const iso = now.toISOString();
    const describe = (zone: string) => `${utcOffset(zone, now)} · 现在 ${formatDateTime(iso, zone).split(" ")[1]}`;
    const common = new Set(COMMON_TIME_ZONES.map((z) => z.zone));
    const list: Option[] = [
      { zone: null, title: "跟随设备", description: `每台设备用自己的时区（这台：${device}，${describe(device)}）` },
      ...COMMON_TIME_ZONES.map((z) => ({ zone: z.zone, title: z.label, description: `${z.zone} · ${describe(z.zone)}` })),
      ...allTimeZones()
        .filter((z) => !common.has(z))
        .map((z) => ({ zone: z, title: z.replace(/_/g, " "), description: describe(z) })),
    ];
    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, COMMON_TIME_ZONES.length + 1);
    return list.filter((o) => `${o.title} ${o.zone ?? ""} ${o.description}`.toLowerCase().includes(q)).slice(0, 80);
  }, [query, now]);

  const choose = async (zone: string | null) => {
    try {
      await api.updateSettings({ timeZone: zone });
      toast.success(zone ? `时区已设为 ${zone}` : "时区改为跟随设备");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const setAutoTrust = async (on: boolean) => {
    try {
      await api.updateSettings({ autoTrust: on });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>保存在你的电脑上，所有设备共享，改了立即生效。</DialogDescription>
        </DialogHeader>
        <Field orientation="horizontal">
          <Checkbox id="auto-trust" checked={autoTrust} onCheckedChange={(v) => void setAutoTrust(v === true)} />
          <FieldContent>
            <FieldLabel htmlFor="auto-trust">自动信任文件夹</FieldLabel>
            <FieldDescription>
              Claude / Codex 问「是否信任这个文件夹」时自动选「信任」，包括电脑重启后自动恢复的会话。
            </FieldDescription>
          </FieldContent>
        </Field>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="text-sm font-medium">时区</div>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="搜索时区，如 Shanghai、Tokyo、UTC+8" value={query} onChange={(e) => setQuery(e.target.value)} />
          </InputGroup>
          <div className="-mx-1 flex max-h-80 flex-col gap-0.5 overflow-y-auto px-1">
            {options.map((o) => {
              const selected = o.zone === current;
              return (
                <button
                  key={o.zone ?? "device"}
                  onClick={() => void choose(o.zone)}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent",
                    selected && "bg-accent",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{o.title}</div>
                    <div className="truncate text-xs text-muted-foreground">{o.description}</div>
                  </div>
                  {selected && <CheckIcon className="size-4 shrink-0" />}
                </button>
              );
            })}
            {options.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">没有匹配的时区</p>}
            {!query && <p className="px-3 pt-2 text-xs text-muted-foreground">没有你要的？在上面搜索全部时区。</p>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
