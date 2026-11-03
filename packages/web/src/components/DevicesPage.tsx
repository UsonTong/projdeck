import type { AgentKeySummary, DeviceView } from "@projdeck/shared";
import { ArrowLeftIcon, BatteryChargingIcon, BatteryIcon, CopyIcon, DownloadIcon, KeyRoundIcon, ShieldCheckIcon, SignalIcon, SmartphoneIcon, Trash2Icon, WifiIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { useWide } from "../live.ts";
import { openSession } from "../router.ts";

/*
 * 设备：连进 projdeck 的设备。目前是通过「远程 adb」中继连上来的安卓手机，手机 App 每 30 秒报一次状态。
 * 手机断开后还会留着最后一次的样子（标成不在线），方便知道它最后什么时候在线。
 */

/** 几分钟前、几小时前…… */
function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
  return `${Math.floor(s / 86400)} 天`;
}

const NETWORK = { wifi: "Wi‑Fi", mobile: "移动数据", none: "没有网络" } as const;

function Fact(props: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground [&_svg]:size-4">
      {props.icon}
      {props.children}
    </span>
  );
}

function DeviceCard({ d, now }: { d: DeviceView; now: number }) {
  const copy = () => navigator.clipboard.writeText(d.adb!.command).then(() => toast.success("已复制"), () => toast.error("复制失败"));
  return (
    <section className={cn("rounded-xl border bg-card p-4", !d.online && "opacity-70")}>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted ring-1 ring-border">
          <SmartphoneIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{d.name}</div>
          <div className="truncate text-xs text-muted-foreground">{[d.os, d.appVersion && `projdeck ${d.appVersion}`].filter(Boolean).join(" · ")}</div>
        </div>
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs", d.online ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
          <span className={cn("size-2 rounded-full", d.online ? "bg-emerald-500" : "bg-muted-foreground/50")} />
          {d.online ? `在线 ${ago(d.since ?? d.lastSeen, now)}` : `${ago(d.lastSeen, now)}前离线`}
        </span>
      </div>

      {d.online && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {d.battery !== null && (
            <Fact icon={d.charging ? <BatteryChargingIcon /> : <BatteryIcon />}>
              {d.battery}%{d.charging ? " 充电中" : ""}
            </Fact>
          )}
          {d.network && <Fact icon={d.network === "wifi" ? <WifiIcon /> : d.network === "mobile" ? <SignalIcon /> : <WifiOffIcon />}>{NETWORK[d.network]}</Fact>}
          {d.vpn && <Fact icon={<ShieldCheckIcon />}>手机上开着 VPN</Fact>}
          {d.tcpMode !== null && <Fact icon={<span className={cn("size-2 rounded-full", d.tcpMode ? "bg-emerald-500" : "bg-amber-500")} />}>{d.tcpMode ? "adb 就绪" : "adb 的 TCP 模式没开（会自动恢复）"}</Fact>}
        </div>
      )}

      {d.adb && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-muted/60 py-1.5 pr-1.5 pl-3">
          <code className="min-w-0 flex-1 truncate text-sm">{d.adb.command}</code>
          <Button variant="ghost" size="icon-sm" aria-label="复制命令" onClick={copy}>
            <CopyIcon />
          </Button>
        </div>
      )}
      {d.adb && d.adb.connections > 0 && <div className="mt-2 text-xs text-muted-foreground">电脑上正有 {d.adb.connections} 个 adb 连接</div>}
    </section>
  );
}

/*
 * 被控端密钥：装在被控端 App 里的专用密钥，只能连转发通道（/ws/adb），拿它登录不了 projdeck，
 * 也访问不了会话、文件、终端。一台设备一把，可以单独吊销。明文只在生成时显示一次。
 */
function AgentKeysCard() {
  const [keys, setKeys] = useState<AgentKeySummary[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState<{ key: AgentKeySummary; token: string } | null>(null);
  const load = () => api.agentKeys().then((r) => setKeys(r.keys), (err: Error) => toast.error(err.message));
  useEffect(() => void load(), []);
  const create = async () => {
    setCreating(true);
    try {
      setToken(await api.createAgentKey(name));
      setName("");
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  };
  const remove = async (k: AgentKeySummary) => {
    try {
      await api.deleteAgentKey(k.id);
      if (token?.key.id === k.id) setToken(null);
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <KeyRoundIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">被控端密钥</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        装在被控端 App 里，只能连接这台手机的转发通道，不能登录 projdeck。一台设备一把，可以单独吊销。
      </p>
      <div className="mt-3 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="设备名，例如 红米 K20 Pro"
          className="min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <Button size="sm" disabled={creating} onClick={() => void create()}>
          {creating && <Spinner data-icon="inline-start" />}
          生成
        </Button>
      </div>
      {token && (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="text-xs text-muted-foreground">「{token.key.name}」的密钥，只显示这一次，请填到被控端 App 里：</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{token.token}</code>
            <Button variant="ghost" size="icon-sm" aria-label="复制" onClick={() => navigator.clipboard.writeText(token.token).then(() => toast.success("已复制"), () => toast.error("复制失败"))}>
              <CopyIcon />
            </Button>
          </div>
        </div>
      )}
      {keys && keys.length > 0 && (
        <div className="mt-3 flex flex-col divide-y text-sm">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate">{k.name}</div>
                <div className="text-xs text-muted-foreground">
                  生成于 {new Date(k.createdAt).toLocaleDateString("zh-CN")}
                  {k.lastUsedAt ? ` · 最近使用 ${new Date(k.lastUsedAt).toLocaleString("zh-CN", { hour12: false })}` : " · 还没用过"}
                </div>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={`吊销 ${k.name}`} onClick={() => void remove(k)}>
                <Trash2Icon />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function DevicesPage() {
  const wide = useWide();
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.devices().then(
        (r) => alive && (setDevices(r.devices), setNow(Date.now())),
        () => {},
      );
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
        {!wide && (
          <Button variant="ghost" size="icon" aria-label="返回" onClick={() => openSession(null)}>
            <ArrowLeftIcon />
          </Button>
        )}
        <span className="ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted ring-1 ring-border">
          <SmartphoneIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">设备</div>
          <div className="truncate text-xs text-muted-foreground">连进 projdeck 的手机，电脑上可以用 adb 直接操作</div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {devices === null ? (
            <div className="flex justify-center py-12">
              <Spinner className="size-5" />
            </div>
          ) : devices.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              还没有设备连进来。
              <br />
              在手机上安装「projdeck 被控端」，填服务器地址和访问密钥，打开「远程连接」，手机就会出现在这里。
            </div>
          ) : (
            devices.map((d) => <DeviceCard key={d.id} d={d} now={now} />)
          )}
          <AgentKeysCard />
          <a
            href="/app/projdeck-agent.apk"
            className="flex items-center gap-3 rounded-xl border bg-card p-4 text-sm transition-colors hover:bg-accent/60"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted ring-1 ring-border">
              <DownloadIcon className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium">projdeck 被控端</span>
              <span className="block truncate text-xs text-muted-foreground">装在被远程控制的手机上。只需要这一个 App，不用装 projdeck。</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">下载</span>
          </a>
        </div>
      </div>
    </div>
  );
}
