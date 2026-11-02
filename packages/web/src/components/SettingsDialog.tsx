import { CheckIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { setDevicePref, useTerminalSizing } from "@/lib/devicePrefs";
import { BAR_KEYS, DEFAULT_BAR_KEYS, setBarKeys, useBarKeys } from "@/lib/keybar";
import { disablePush, enablePush, pushState, testPush, type PushState } from "@/lib/push";
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

/** 设置：通知（本设备）、自动信任文件夹、终端尺寸（本设备）、快捷键条（本设备）、时区。时区用可搜索的列表直接选，不用下拉菜单。 */
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { overview } = useLive();
  const current = overview?.settings.timeZone ?? null;
  const autoTrust = overview?.settings.autoTrust ?? true;
  const sizing = useTerminalSizing();
  const barKeys = useBarKeys();
  // 安卓 App（发布了才显示下载）
  const [androidApp, setAndroidApp] = useState<{ version: string; size: number; builtAt: string } | null>(null);
  useEffect(() => {
    if (open) api.androidApp().then(setAndroidApp, () => undefined);
  }, [open]);
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    if (open) pushState().then(setPush, () => setPush("unsupported"));
  }, [open]);
  const pushAction = async (fn: () => Promise<void>, done?: string) => {
    setPushBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPushBusy(false);
      setPush(await pushState().catch(() => "unsupported" as const));
    }
  };
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
      <DialogContent
        // 手机上占满整屏，内容多时可以滚动
        className="max-h-[calc(100dvh-2rem)] content-start overflow-y-auto sm:max-w-md max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:pt-[calc(1rem+env(safe-area-inset-top))] max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))] max-sm:ring-0 max-sm:[&>[data-slot=dialog-close]]:top-[calc(0.5rem+env(safe-area-inset-top))]"
      >
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>保存在你的电脑上，所有设备共享，改了立即生效。</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-sm font-medium">通知（这台设备）</div>
          <p className="text-xs text-muted-foreground">
            {push === null && "检查中…"}
            {push === "on" && "已开启：Claude / Codex / Pi 完成或需要你处理时，这台设备会收到通知，点通知直接打开那个会话。"}
            {push === "off" && "开启后，Claude / Codex / Pi 完成或需要你处理时推送到这台设备，不用一直开着网页。"}
            {push === "denied" && "通知权限被拒绝了，需要在浏览器或系统设置里允许 projdeck 发通知，然后再回来开启。"}
            {push === "needs-install" && "iPhone / iPad 需要先把 projdeck 添加到主屏幕（Safari 分享按钮 → 添加到主屏幕），再从主屏幕打开 projdeck 开启通知。"}
            {push === "unsupported" && "这个浏览器不支持推送通知。"}
          </p>
          {(push === "on" || push === "off") && (
            <div className="flex gap-2">
              {push === "off" ? (
                <Button size="sm" disabled={pushBusy} onClick={() => void pushAction(enablePush, "已开启通知")}>
                  {pushBusy && <Spinner data-icon="inline-start" />}
                  开启通知
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="outline" disabled={pushBusy} onClick={() => void pushAction(testPush, "已发送，几秒内会收到")}>
                    发送测试通知
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pushBusy} onClick={() => void pushAction(disablePush, "已关闭通知")}>
                    关闭
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
        <Field orientation="horizontal">
          <Checkbox id="auto-trust" checked={autoTrust} onCheckedChange={(v) => void setAutoTrust(v === true)} />
          <FieldContent>
            <FieldLabel htmlFor="auto-trust">自动信任文件夹</FieldLabel>
            <FieldDescription>
              Claude / Codex 问「是否信任这个文件夹」时自动选「信任」，包括电脑重启后自动恢复的会话。
            </FieldDescription>
          </FieldContent>
        </Field>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-sm font-medium">终端尺寸（这台设备）</div>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={sizing}
            onValueChange={(v) => v && setDevicePref("termSizing", v)}
            className="w-full"
          >
            <ToggleGroupItem value="auto" className="flex-1">自动</ToggleGroupItem>
            <ToggleGroupItem value="fit" className="flex-1">适配本设备</ToggleGroupItem>
            <ToggleGroupItem value="desktop" className="flex-1">跟随电脑</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            一个终端同一时刻只能有一种尺寸。自动：谁最近在操作谁优先，在网页上点击、打字时用网页的尺寸，在电脑上切到
            Ghostty 时恢复电脑的尺寸（这时网页按电脑的行列数缩小显示）。网页只是失去焦点不会让出尺寸。手机上始终适配本设备。
          </p>
        </div>
        {androidApp && (
          <div className="flex min-w-0 flex-col gap-2">
            <div className="text-sm font-medium">安卓 App</div>
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                原生 App：列表、终端、对话、文件、CC Switch，后台通知不经过谷歌推送。版本 {androidApp.version.split("+")[0]} ·{" "}
                {(androidApp.size / 1024 / 1024).toFixed(1)} MB · {formatDateTime(androidApp.builtAt, current ?? deviceTimeZone())} 发布
              </p>
              <Button size="sm" variant="outline" asChild>
                <a href="/app/projdeck.apk" download>
                  下载
                </a>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">在手机浏览器里点下载，下载完成后打开安装（第一次需要允许浏览器安装应用）。已经装过的会直接升级。</p>
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">快捷键条（这台设备）</div>
            {barKeys.map((k) => k.id).join(" ") !== DEFAULT_BAR_KEYS.join(" ") && (
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setBarKeys(null)}>
                恢复默认
              </Button>
            )}
          </div>
          <ToggleGroup
            type="multiple"
            variant="outline"
            size="sm"
            spacing={1}
            value={barKeys.map((k) => k.id)}
            onValueChange={setBarKeys}
            className="flex-wrap justify-start"
          >
            {BAR_KEYS.map((k) => (
              <ToggleGroupItem key={k.id} value={k.id} title={k.title} className="min-w-9 font-mono text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                {k.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">终端下方那一排按键，点选要显示的键。方向键和翻页键按住会连发。</p>
        </div>
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
