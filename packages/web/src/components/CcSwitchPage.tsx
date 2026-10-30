import type { CcSwitchApp, CcSwitchStatus, CcUsage, CcUsageRange, CcUsageRow } from "@projdeck/shared";
import { ArrowLeftIcon, ArrowRightLeftIcon, CheckIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, useTimeZone } from "@/lib/time";
import { cn } from "@/lib/utils";
import { api } from "../api.ts";
import { useWide } from "../live.ts";
import { openCcSwitch, openSession } from "../router.ts";

/*
 * CC Switch（AI 编程工具的供应商管理器）在网页上的界面：各应用的供应商（点一下切换，经由 CC Switch 自己完成），
 * 以及用量统计（只读，读它的数据库，与它的「用量」页同口径）。布局仿照 CC Switch：左侧栏目，右侧内容；手机上栏目在顶部横排。
 */

const RANGES: { value: CcUsageRange; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "all", label: "全部" },
];

const CATEGORY: Record<string, string> = { official: "官方", cn_official: "国内官方", aggregator: "聚合", third_party: "第三方", custom: "自定义" };

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** 4.33B、935M、18.6M：三位有效数字，去掉小数部分末尾的 0。 */
const compact = (n: number) => {
  for (const [v, unit] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const)
    if (n >= v) return `${Number((n / v).toFixed(n >= v * 100 ? 0 : n >= v * 10 ? 1 : 2))}${unit}`;
  return String(Math.round(n));
};
const host = (url: string | null) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

/** 栏目切换按钮（侧栏里竖排，手机上横排）。 */
function NavItem(props: { active: boolean; onClick: () => void; children: React.ReactNode; sub?: string | null }) {
  // 手机上栏目横排，当前栏目可能在屏幕外，滚到看得见
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.active]);
  return (
    <button
      ref={ref}
      onClick={props.onClick}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent/60",
        props.active && "bg-accent hover:bg-accent",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{props.children}</span>
      {props.sub && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{props.sub}</span>}
    </button>
  );
}

/**
 * 电脑上显示 CC Switch 原版的完整界面（编译好的前端，操作经 projdeck 转给电脑上的 CC Switch 执行）；
 * 还没开启转发或没编译界面时，以及在手机上，显示 projdeck 自己的界面。
 */
export function CcSwitchPage({ section }: { section: string }) {
  const wide = useWide();
  const [bridge, setBridge] = useState<{ available: boolean; ui: { version: string; exact: boolean } | null } | null>(null);
  const [enabling, setEnabling] = useState(false);
  useEffect(() => {
    if (wide) api.ccswitchBridge().then(setBridge, () => setBridge({ available: false, ui: null }));
  }, [wide]);
  const enable = async () => {
    setEnabling(true);
    try {
      await api.ccswitchEnableBridge();
      setBridge(await api.ccswitchBridge());
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setEnabling(false);
    }
  };
  if (wide && bridge?.available && bridge.ui) {
    return <iframe src="/ccswitch-ui/" title="CC Switch" className="min-h-0 flex-1 border-0 bg-background" />;
  }
  if (wide && !bridge) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }
  return <CcSwitchLite section={section} offer={wide && bridge?.ui && !bridge.available ? { enabling, enable } : null} />;
}

function CcSwitchLite({ section, offer }: { section: string; offer: { enabling: boolean; enable: () => void } | null }) {
  const wide = useWide();
  const [status, setStatus] = useState<CcSwitchStatus | null>(null);
  const [todayCost, setTodayCost] = useState<number | null>(null);
  const refresh = useCallback(() => api.ccswitch().then(setStatus, (err: Error) => toast.error(err.message)), []);
  useEffect(() => void refresh(), [refresh]);

  const current = (a: CcSwitchApp) => a.providers.find((p) => p.current)?.name ?? null;
  const app = status?.apps.find((a) => a.app === section);

  const nav = status && (
    <>
      <NavItem active={section === "usage"} onClick={() => openCcSwitch("usage")} sub={todayCost !== null ? `今天 ${usd(todayCost)}` : null}>
        用量
      </NavItem>
      {wide && <div className="px-2.5 pt-3 pb-1 text-xs text-muted-foreground">供应商</div>}
      {status.apps.map((a) => (
        <NavItem key={a.app} active={section === a.app} onClick={() => openCcSwitch(a.app)} sub={wide ? current(a) : null}>
          {a.label}
        </NavItem>
      ))}
      {wide && <div className="px-2.5 pt-3 pb-1 text-xs text-muted-foreground">扩展</div>}
      {EXTRA_SECTIONS.map((x) => (
        <NavItem key={x.key} active={section === x.key} onClick={() => openCcSwitch(x.key)}>
          {x.label}
        </NavItem>
      ))}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2">
        {!wide && (
          <Button variant="ghost" size="icon" aria-label="返回" onClick={() => openSession(null)}>
            <ArrowLeftIcon />
          </Button>
        )}
        <span className="ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted ring-1 ring-border">
          <ArrowRightLeftIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">CC Switch</div>
          <div className="truncate text-xs text-muted-foreground">
            {status ? (status.running ? "电脑上正在运行" : "电脑上没有运行（切换时会在后台启动）") : "读取中…"}
          </div>
        </div>
      </header>
      {offer && (
        <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2.5 text-sm">
          <span className="min-w-0 flex-1 text-muted-foreground">
            可以在这里显示 CC Switch 的完整界面（供应商增删改、MCP、Skills、Prompts、会话、设置……），需要让电脑上的 CC Switch 开一个只监听本机的调试端口，开启时它会重启一下。
          </span>
          <Button size="sm" disabled={offer.enabling} onClick={offer.enable}>
            {offer.enabling && <Spinner data-icon="inline-start" />}
            开启完整界面
          </Button>
        </div>
      )}
      {!status ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : !status.installed ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">这台电脑上没有检测到 CC Switch。</div>
      ) : (
        <div className={cn("flex min-h-0 flex-1", !wide && "flex-col")}>
          {wide ? (
            <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">{nav}</nav>
          ) : (
            <nav className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5 [scrollbar-width:none]">{nav}</nav>
          )}
          <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
            {section === "usage" ? (
              <UsageView onTodayCost={setTodayCost} />
            ) : section === "mcp" ? (
              <NeedsBridge>
                <McpView />
              </NeedsBridge>
            ) : section === "prompts" ? (
              <NeedsBridge>
                <PromptsView apps={status.apps} />
              </NeedsBridge>
            ) : section === "skills" ? (
              <NeedsBridge>
                <SkillsView />
              </NeedsBridge>
            ) : app ? (
              <ProvidersView app={app} onStatus={setStatus} />
            ) : (
              <div className="p-6 text-sm text-muted-foreground">没有这个应用。</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 供应商
// ---------------------------------------------------------------------------

function ProvidersView({ app, onStatus }: { app: CcSwitchApp; onStatus: (s: CcSwitchStatus) => void }) {
  const [switching, setSwitching] = useState<string | null>(null);
  const pick = async (id: string) => {
    if (switching) return;
    setSwitching(id);
    try {
      const r = await api.ccswitchSwitch(app.app, id);
      onStatus(r);
      const name = app.providers.find((p) => p.id === id)?.name ?? id;
      toast.success(`${app.label} 已切换到 ${name}`, {
        description: `之后新开的 ${app.label} 会话生效` + (r.launched ? "（已在后台启动 CC Switch）" : ""),
      });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <p className="text-xs text-muted-foreground">
        点一下切换，和在 CC Switch 里切换完全一样（由它完成），改的是电脑上的全局配置：之后新开的 {app.label} 会话生效，正在运行的不受影响。
      </p>
      <div className="flex flex-col gap-1.5">
        {app.providers.map((p) => {
          const site = host(p.website);
          return (
            <button
              key={p.id}
              disabled={!!switching}
              onClick={() => !p.current && void pick(p.id)}
              className={cn(
                "flex items-center gap-3 rounded-xl px-4 py-3 text-left ring-1 ring-border transition-colors hover:bg-accent/60 disabled:pointer-events-none",
                p.current && "bg-accent ring-foreground/30 hover:bg-accent",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  {p.category && CATEGORY[p.category] && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">{CATEGORY[p.category]}</span>
                  )}
                </div>
                {site && <div className="truncate text-xs text-muted-foreground">{site}</div>}
              </div>
              {switching === p.id ? (
                <Spinner />
              ) : p.current ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <CheckIcon className="size-4 text-foreground" />
                  使用中
                </span>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">切换</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 用量
// ---------------------------------------------------------------------------

type Metric = "cost" | "requests" | "tokens";
type Table = "models" | "providers" | "logs";

/** 一组互斥选项（时间范围、应用、表格），直接点选，不用下拉菜单。 */
function Segmented<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cn("flex shrink-0 rounded-md bg-muted p-0.5", props.className)}>
      {props.options.map((o) => (
        <button
          key={o.value}
          onClick={() => props.onChange(o.value)}
          className={cn(
            "rounded px-2.5 py-1 text-xs whitespace-nowrap text-muted-foreground transition-colors",
            props.value === o.value && "bg-background text-foreground shadow-sm",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function UsageView({ onTodayCost }: { onTodayCost: (n: number) => void }) {
  const [range, setRange] = useState<CcUsageRange>("7d");
  const [app, setApp] = useState("");
  const [metric, setMetric] = useState<Metric>("tokens");
  const [table, setTable] = useState<Table>("models");
  const [data, setData] = useState<CcUsage | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .ccswitchUsage(range, app)
      .then(
        (u) => {
          setData(u);
          onTodayCost(u.summary.todayCost);
        },
        (err: Error) => toast.error(err.message),
      )
      .finally(() => setLoading(false));
  }, [range, app, onTodayCost]);
  useEffect(load, [load]);

  if (!data) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }

  const s = data.summary;
  const cards: { key: Metric | "cache"; label: string; value: string }[] = [
    { key: "cost", label: "花费", value: usd(s.cost) },
    { key: "requests", label: "请求数", value: s.requests.toLocaleString("en-US") },
    { key: "tokens", label: "Tokens", value: compact(s.tokens) },
    { key: "cache", label: "缓存命中率", value: `${(s.cacheHitRate * 100).toFixed(1)}%` },
  ];
  const metricLabel = { cost: "花费", requests: "请求数", tokens: "Tokens" }[metric];

  return (
    <div className={cn("mx-auto flex max-w-5xl flex-col gap-4 p-4 transition-opacity", loading && "opacity-60")}>
      {/* 筛选：一行，时间范围 + 应用 */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={range} options={RANGES} onChange={setRange} />
        <Segmented
          value={app}
          options={[{ value: "", label: "全部" }, ...data.apps.map((a) => ({ value: a.app, label: a.label }))]}
          onChange={setApp}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="刷新" className="ml-auto" onClick={load}>
              <RotateCwIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>刷新</TooltipContent>
        </Tooltip>
      </div>

      <div className="rounded-xl ring-1 ring-border">
        {/* 指标卡：点花费 / 请求数 / Tokens 切换下面图表的指标 */}
        <div className="grid grid-cols-2 border-b sm:grid-cols-4">
          {cards.map((c) => {
            const selectable = c.key !== "cache";
            const selected = c.key === metric;
            return (
              <button
                key={c.key}
                disabled={!selectable}
                onClick={() => selectable && setMetric(c.key as Metric)}
                className={cn(
                  "relative flex flex-col gap-1 px-4 py-3 text-left disabled:cursor-default",
                  selectable && "hover:bg-accent/40",
                  selected && "after:absolute after:inset-x-4 after:bottom-0 after:h-0.5 after:bg-foreground",
                )}
              >
                <span className="text-xs text-muted-foreground">{c.label}</span>
                <span className="text-2xl font-semibold tabular-nums">{c.value}</span>
              </button>
            );
          })}
        </div>
        <div className="p-4">
          <div className="mb-2 text-xs text-muted-foreground">
            {metricLabel} · {range === "today" ? "每小时" : "每天"}
          </div>
          <BarChart series={data.series} metric={metric} />
        </div>
      </div>

      <div className="rounded-xl ring-1 ring-border">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Segmented
            value={table}
            options={[
              { value: "models", label: `模型 ${data.models.length}` },
              { value: "providers", label: `供应商 ${data.providers.length}` },
              { value: "logs", label: "请求记录" },
            ]}
            onChange={setTable}
          />
        </div>
        <div className="overflow-x-auto">
          {table === "logs" ? <LogsTable logs={data.logs} /> : <UsageTable rows={table === "models" ? data.models : data.providers} />}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">数据来自 CC Switch（只读），与它的用量页同口径。「≈」表示由会话日志估算（含等待首字的时间）。</p>
    </div>
  );
}

/** 每天（或每小时）一根柱子：单一系列，悬停显示这一天的全部指标。 */
function BarChart({ series, metric }: { series: CcUsage["series"]; metric: Metric }) {
  const [hover, setHover] = useState<number | null>(null);
  const H = 160;
  const max = Math.max(...series.map((d) => d[metric]), 0);
  // 纵轴刻度取整：1、2、5 × 10^n
  const step = (() => {
    if (max <= 0) return 1;
    const raw = max / 3;
    const p = 10 ** Math.floor(Math.log10(raw));
    return ([1, 2, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
  })();
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const fmt = (v: number) => (metric === "cost" ? `$${compact(v)}` : compact(v));
  const n = series.length;
  const showLabel = (i: number) => n <= 14 || i % Math.ceil(n / 10) === 0 || i === n - 1;

  return (
    <div className="flex gap-2">
      <div className="relative w-10 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums" style={{ height: H }}>
        {ticks.map((t) => (
          <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: H - (t / top) * H }}>
            {fmt(t)}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative" style={{ height: H }} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 h-px bg-border" style={{ top: H - (t / top) * H }} />
          ))}
          <div className="absolute inset-0 flex">
            {series.map((d, i) => {
              const h = top ? (d[metric] / top) * H : 0;
              return (
                // 整个时间格都是悬停 / 点按区域，比柱子大
                <div
                  key={d.label}
                  className="relative flex flex-1 items-end justify-center"
                  onMouseEnter={() => setHover(i)}
                  onClick={() => setHover(hover === i ? null : i)}
                >
                  {hover === i && <div className="absolute inset-0 rounded bg-accent/40" />}
                  <div
                    className="relative w-full max-w-6 rounded-t-[4px] bg-[#1d8ac7] dark:bg-[#2b93cf]"
                    style={{ height: d[metric] > 0 ? Math.max(2, h) : 0, marginInline: 2 }}
                  />
                </div>
              );
            })}
          </div>
          {hover !== null && series[hover] && (
            <div
              className="pointer-events-none absolute z-10 rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10"
              style={{
                left: `${((hover + 0.5) / n) * 100}%`,
                top: 0,
                transform: `translateX(${hover / n > 0.6 ? "-105%" : "5%"})`,
              }}
            >
              <div className="mb-1 font-medium">{series[hover].label}</div>
              <div className="grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
                <span className="text-muted-foreground">花费</span>
                <span>{usd(series[hover].cost)}</span>
                <span className="text-muted-foreground">请求数</span>
                <span>{series[hover].requests.toLocaleString("en-US")}</span>
                <span className="text-muted-foreground">Tokens</span>
                <span>{compact(series[hover].tokens)}</span>
              </div>
            </div>
          )}
        </div>
        <div className="mt-1 flex text-[10px] text-muted-foreground tabular-nums">
          {series.map((d, i) => (
            <span key={d.label} className="flex-1 truncate text-center">
              {showLabel(i) ? d.label : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const TH = "px-4 py-2 text-left text-xs font-normal whitespace-nowrap text-muted-foreground";
const TD = "px-4 py-2.5 whitespace-nowrap tabular-nums";

function UsageTable({ rows }: { rows: CcUsageRow[] }) {
  if (rows.length === 0) return <div className="p-6 text-center text-sm text-muted-foreground">这段时间没有记录</div>;
  return (
    <table className="w-full text-sm">
      <thead className="border-b">
        <tr>
          <th className={TH}>名称</th>
          <th className={TH}>请求数</th>
          <th className={TH}>花费</th>
          <th className={TH}>Tokens</th>
          <th className={TH}>成功率</th>
          <th className={TH}>速度</th>
          <th className={TH}>首字</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((r) => (
          <tr key={`${r.app}|${r.name}`}>
            <td className={cn(TD, "font-mono text-xs")}>{r.name}</td>
            <td className={TD}>{r.requests.toLocaleString("en-US")}</td>
            <td className={TD}>{usd(r.cost)}</td>
            <td className={TD}>{compact(r.tokens)}</td>
            <td className={TD}>{(r.successRate * 100).toFixed(r.successRate === 1 ? 0 : 1)}%</td>
            <td className={TD}>
              {r.speed === null ? (
                "—"
              ) : (
                <>
                  {r.speedEstimated && "≈"}
                  {Math.round(r.speed)}
                  <span className="text-xs text-muted-foreground"> tok/s</span>
                </>
              )}
            </td>
            <td className={TD}>{r.firstTokenMs === null ? "—" : `${r.firstTokenEstimated ? "≈" : ""}${(r.firstTokenMs / 1000).toFixed(1)}s`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LogsTable({ logs }: { logs: CcUsage["logs"] }) {
  const timeZone = useTimeZone();
  if (logs.length === 0) return <div className="p-6 text-center text-sm text-muted-foreground">这段时间没有记录</div>;
  return (
    <table className="w-full text-sm">
      <thead className="border-b">
        <tr>
          <th className={TH}>时间</th>
          <th className={TH}>模型</th>
          <th className={TH}>输入</th>
          <th className={TH}>输出</th>
          <th className={TH}>缓存读 / 写</th>
          <th className={TH}>花费</th>
          <th className={TH}>耗时</th>
          <th className={TH}>状态</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {logs.map((l, i) => (
          <tr key={i}>
            <td className={cn(TD, "text-xs text-muted-foreground")}>{formatDateTime(new Date(l.at).toISOString(), timeZone)}</td>
            <td className={cn(TD, "font-mono text-xs")}>{l.model}</td>
            <td className={TD}>{compact(l.input)}</td>
            <td className={TD}>{compact(l.output)}</td>
            <td className={TD}>
              {compact(l.cacheRead)} / {compact(l.cacheCreation)}
            </td>
            <td className={TD}>{usd(l.cost)}</td>
            <td className={TD}>{(l.latencyMs / 1000).toFixed(1)}s</td>
            <td className={cn(TD, l.status >= 400 && "text-destructive")}>{l.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// MCP、Prompts、Skills：经调试端口在电脑上的 CC Switch 里操作
// ---------------------------------------------------------------------------

const EXTRA_SECTIONS = [
  { key: "mcp", label: "MCP" },
  { key: "prompts", label: "Prompts" },
  { key: "skills", label: "Skills" },
];

/** MCP / Skills 可以分别启用到哪些应用（与 CC Switch 的列一致）。 */
const TARGET_APPS: { app: string; label: string }[] = [
  { app: "claude", label: "Claude" },
  { app: "codex", label: "Codex" },
  { app: "gemini", label: "Gemini" },
  { app: "grokbuild", label: "Grok" },
  { app: "opencode", label: "OpenCode" },
  { app: "openclaw", label: "OpenClaw" },
  { app: "hermes", label: "Hermes" },
  { app: "pi", label: "Pi" },
  { app: "mcode", label: "MiniMax" },
  { app: "kimi", label: "Kimi" },
  { app: "agy", label: "Antigravity" },
];

/** 这些栏目要经调试端口操作 CC Switch；没开启时提示开启（会重启一下电脑上的 CC Switch）。 */
function NeedsBridge({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "ok" | "off">("checking");
  const [enabling, setEnabling] = useState(false);
  useEffect(() => {
    api.ccswitchBridge().then((b) => setState(b.available ? "ok" : "off"), () => setState("off"));
  }, []);
  if (state === "ok") return <>{children}</>;
  if (state === "checking")
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <p>这一栏要直接操作电脑上的 CC Switch，需要它开一个只监听本机的调试端口（开启时它会重启一下）。</p>
      <Button
        size="sm"
        disabled={enabling}
        onClick={async () => {
          setEnabling(true);
          try {
            await api.ccswitchEnableBridge();
            setState("ok");
          } catch (err) {
            toast.error((err as Error).message);
          } finally {
            setEnabling(false);
          }
        }}
      >
        {enabling && <Spinner data-icon="inline-start" />}
        开启
      </Button>
    </div>
  );
}

/** 一排应用开关：点一下启用 / 停用。 */
function AppChips(props: { apps: Record<string, boolean | undefined>; busy: string | null; onToggle: (app: string, enabled: boolean) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {TARGET_APPS.map((a) => {
        const on = !!props.apps[a.app];
        return (
          <button
            key={a.app}
            disabled={props.busy === a.app}
            onClick={() => props.onToggle(a.app, !on)}
            aria-pressed={on}
            className={cn(
              "flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ring-1 transition-colors disabled:opacity-50",
              on ? "bg-primary text-primary-foreground ring-primary" : "text-muted-foreground ring-border hover:bg-accent/60",
            )}
          >
            {props.busy === a.app ? <Spinner className="size-3" /> : on && <CheckIcon className="size-3" />}
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

type McpServer = {
  id: string;
  name: string;
  description?: string;
  server: { type?: string; command?: string; args?: string[]; url?: string };
  apps: Record<string, boolean | undefined>;
};

function McpView() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api.ccInvoke<Record<string, McpServer>>("get_mcp_servers").then(
        (r) => setServers(Object.values(r)),
        (err: Error) => toast.error(err.message),
      ),
    [],
  );
  useEffect(() => void load(), [load]);
  const toggle = async (s: McpServer, app: string, enabled: boolean) => {
    setBusy(`${s.id}|${app}`);
    try {
      await api.ccInvoke("set_mcp_enabled", { app, id: s.id, enabled });
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!servers) return <Loading />;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <p className="text-xs text-muted-foreground">点应用名启用或停用这个 MCP 服务器，CC Switch 会同步写进对应应用的配置。新增、编辑请在电脑上的完整界面里操作。</p>
      {servers.length === 0 && <Empty text="还没有 MCP 服务器" />}
      {servers.map((s) => (
        <div key={s.id} className="flex flex-col gap-2.5 rounded-xl px-4 py-3 ring-1 ring-border">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{s.name}</span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">{s.server.type ?? "stdio"}</span>
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">{s.server.url ?? [s.server.command, ...(s.server.args ?? [])].join(" ")}</div>
            {s.description && <div className="mt-1 text-xs text-muted-foreground">{s.description}</div>}
          </div>
          <AppChips
            apps={s.apps}
            busy={busy?.startsWith(`${s.id}|`) ? busy.slice(s.id.length + 1) : null}
            onToggle={(app, on) => void toggle(s, app, on)}
          />
        </div>
      ))}
    </div>
  );
}

type Prompt = { id: string; name: string; content: string; description?: string; enabled: boolean };

function PromptsView({ apps }: { apps: CcSwitchApp[] }) {
  const [app, setApp] = useState(apps[0]?.app ?? "claude");
  const [prompts, setPrompts] = useState<Prompt[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const options = [...new Map([...apps.map((a) => [a.app, a.label] as const), ["hermes", "Hermes"] as const]).entries()].map(([value, label]) => ({
    value,
    label,
  }));
  const load = useCallback(() => {
    setPrompts(null);
    api.ccInvoke<Record<string, Prompt>>("get_prompts", { app }).then(
      (r) => setPrompts(Object.values(r)),
      (err: Error) => toast.error(err.message),
    );
  }, [app]);
  useEffect(load, [load]);
  const enable = async (p: Prompt) => {
    setBusy(p.id);
    try {
      await api.ccInvoke("enable_prompt", { app, id: p.id });
      toast.success(`已启用「${p.name}」`);
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      {/* 应用多时这一行可以横向滑动，不撑宽整页 */}
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none]">
        <Segmented value={app} options={options} onChange={setApp} className="w-max" />
      </div>
      <p className="text-xs text-muted-foreground">启用一个提示词，CC Switch 会把它写进这个应用的提示词文件（如 CLAUDE.md、AGENTS.md）。新增、编辑请在电脑上的完整界面里操作。</p>
      {!prompts ? (
        <Loading />
      ) : prompts.length === 0 ? (
        <Empty text="这个应用还没有提示词" />
      ) : (
        prompts.map((p) => (
          <div key={p.id} className={cn("rounded-xl ring-1 ring-border", p.enabled && "bg-accent ring-foreground/30")}>
            <div className="flex items-center gap-3 px-4 py-3">
              <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === p.id ? null : p.id)}>
                <div className="truncate text-sm font-medium">{p.name}</div>
                {p.description && <div className="truncate text-xs text-muted-foreground">{p.description}</div>}
              </button>
              {p.enabled ? (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <CheckIcon className="size-4 text-foreground" />
                  使用中
                </span>
              ) : (
                <Button size="sm" variant="outline" disabled={busy === p.id} onClick={() => void enable(p)}>
                  {busy === p.id && <Spinner data-icon="inline-start" />}
                  启用
                </Button>
              )}
            </div>
            {open === p.id && (
              <pre className="max-h-80 overflow-auto border-t px-4 py-3 text-xs whitespace-pre-wrap text-muted-foreground">{p.content}</pre>
            )}
          </div>
        ))
      )}
    </div>
  );
}

type Skill = { id: string; name: string; description?: string; repoOwner?: string; repoName?: string; apps: Record<string, boolean | undefined> };

function SkillsView() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api.ccInvoke<Skill[]>("get_installed_skills").then(
        (r) => setSkills(r),
        (err: Error) => toast.error(err.message),
      ),
    [],
  );
  useEffect(() => void load(), [load]);
  const toggle = async (s: Skill, app: string, enabled: boolean) => {
    setBusy(`${s.id}|${app}`);
    try {
      await api.ccInvoke("toggle_skill_app", { id: s.id, app, enabled });
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!skills) return <Loading />;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <p className="text-xs text-muted-foreground">点应用名启用或停用这个 Skill。安装、更新、卸载请在电脑上的完整界面里操作。</p>
      {skills.length === 0 && <Empty text="还没有通过 CC Switch 安装的 Skill" />}
      {skills.map((s) => (
        <div key={s.id} className="flex flex-col gap-2.5 rounded-xl px-4 py-3 ring-1 ring-border">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{s.name}</div>
            {s.repoOwner && <div className="truncate font-mono text-xs text-muted-foreground">{`${s.repoOwner}/${s.repoName ?? ""}`}</div>}
            {s.description && <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{s.description}</div>}
          </div>
          <AppChips apps={s.apps} busy={busy?.startsWith(`${s.id}|`) ? busy.slice(s.id.length + 1) : null} onToggle={(app, on) => void toggle(s, app, on)} />
        </div>
      ))}
    </div>
  );
}

const Loading = () => (
  <div className="flex h-40 items-center justify-center">
    <Spinner className="size-5" />
  </div>
);

const Empty = ({ text }: { text: string }) => <div className="p-6 text-center text-sm text-muted-foreground">{text}</div>;
