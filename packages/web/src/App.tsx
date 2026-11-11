import type { PresentedResource } from "@projdeck/shared";
import { PanelLeftCloseIcon, PanelLeftOpenIcon, TerminalSquareIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTerminalTheme } from "@/lib/terminalTheme";
import { api, authEvents } from "./api.ts";
import { ConfirmHost } from "./components/Confirm.tsx";
import { Login } from "./components/Login.tsx";
import { OverviewPage } from "./components/Overview.tsx";
import { CcSwitchPage } from "./components/CcSwitchPage.tsx";
import { DevicesPage } from "./components/DevicesPage.tsx";
import { DeepSeekPage } from "./components/DeepSeekPage.tsx";
import { TerminalOnlyPage } from "./components/TerminalOnlyPage.tsx";
import { HarnessPage } from "./components/HarnessPage.tsx";
import { FilesPage } from "./components/FilesPage.tsx";
import { SessionPage } from "./components/Session.tsx";
import { live, useLive, useWide } from "./live.ts";
import { useRoute } from "./router.ts";

export function App() {
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    api
      .authStatus()
      .then((s) => {
        setConfigured(s.configured);
        setAuth(s.authenticated ? "in" : "out");
      })
      .catch(() => setAuth("out"));
    const onLogout = () => setAuth("out");
    authEvents.addEventListener("logout", onLogout);
    return () => authEvents.removeEventListener("logout", onLogout);
  }, []);

  useEffect(() => {
    if (auth === "in") live.start();
  }, [auth]);

  return (
    <TooltipProvider>
      {auth === "loading" ? (
        <div className="flex h-full items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      ) : auth === "out" ? (
        <Login configured={configured} onSuccess={() => setAuth("in")} />
      ) : (
        <Shell />
      )}
      <Toaster position="top-center" />
      <ConfirmHost />
      <PresentHost />
    </TooltipProvider>
  );
}

/** Agent 通过 `projdeck present <图片>` 主动展示时弹出的图片层。 */
function PresentHost() {
  const { presents } = useLive();
  const latest = presents[0] ?? null;
  const seen = useRef<string | null>(null);
  const initialized = useRef(false);
  const [open, setOpen] = useState<PresentedResource | null>(null);
  // 页面打开时已经存在的资源不弹；之后新展示的才弹。
  useEffect(() => {
    initialized.current = true;
    seen.current = latest?.id ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!latest || !initialized.current) return;
    if (latest.id === seen.current) return;
    seen.current = latest.id;
    setOpen(latest);
  }, [latest]);
  return (
    <Dialog open={open !== null} onOpenChange={(v) => { if (!v) setOpen(null); }}>
      <DialogContent className="gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{open?.title ?? "Agent 展示"}</DialogTitle>
        </DialogHeader>
        {open && <img src={open.url} alt={open.title} className="max-h-[72vh] w-full rounded-md object-contain" />}
        <p className="truncate font-mono text-xs text-muted-foreground">{open?.path}</p>
      </DialogContent>
    </Dialog>
  );
}

function Banner() {
  const { overview, connected } = useLive();
  const [starting, setStarting] = useState(false);
  if (connected && (!overview || overview.herdr.online)) return null;
  const start = async () => {
    setStarting(true);
    try {
      await api.startHerdr();
      toast.success("herdr 已启动");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setStarting(false);
    }
  };
  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      {connected ? <TerminalSquareIcon /> : <WifiOffIcon />}
      <AlertDescription>
        {connected ? `herdr 未运行：${overview?.herdr.error ?? ""}` : "与本地电脑的连接已断开，正在重连…"}
      </AlertDescription>
      {connected && (
        <AlertAction>
          <Button size="sm" variant="outline" disabled={starting} onClick={() => void start()}>
            {starting && <Spinner data-icon="inline-start" />}
            启动 herdr
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

/** 正在运行的前端入口脚本（开发模式下没有带哈希的入口，不检查）。 */
const runningEntry = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute("src");

/**
 * 本机重新构建了前端后更新页面。手机、平板上的页面常常开着很久不刷新，否则会一直停在旧版本
 * （新旧前端与 agentd 的约定不一致时会出现奇怪的行为）。
 * 只在页面已经切到后台（标签页不可见）时自动刷新：正在看的时候刷新会让 DeepSeek 和终端整个重来。
 * 可见时只弹一条提示，由用户决定何时刷新。未发送的草稿存在本地，刷新不会丢。
 * 在重新连上本机、切回前台时检查，平时每 5 分钟检查一次。
 */
function useUpdateCheck() {
  const { connected } = useLive();
  useEffect(() => {
    if (!runningEntry || !connected) return;
    const check = async () => {
      try {
        const html = await (await fetch("/", { cache: "no-store" })).text();
        const latest = /<script type="module"[^>]* src="([^"]+)"/.exec(html)?.[1];
        if (latest && latest !== runningEntry) {
          // 同一个旧入口只自动刷新一次，防止部署过程中反复刷新成循环
          const key = "projdeck-update-reloaded";
          if (document.visibilityState === "hidden" && sessionStorage.getItem(key) !== runningEntry) {
            sessionStorage.setItem(key, runningEntry);
            return location.reload();
          }
          toast("projdeck 有新版本", {
            id: "update",
            duration: Infinity,
            action: { label: "刷新", onClick: () => { sessionStorage.removeItem(key); location.reload(); } },
          });
        }
      } catch {
        // 离线时下次再查
      }
    };
    void check();
    const onVisible = () => document.visibilityState === "visible" && void check();
    // 切到后台时再查一次：这时自动刷新不会打断正在看的画面
    const onHidden = () => document.visibilityState === "hidden" && void check();
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("visibilitychange", onHidden);
    // 不监听 blur：切到别的窗口不等于离开，整页刷新会很打扰（DeepSeek / 终端都要重新加载）
    const timer = setInterval(check, 5 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("visibilitychange", onHidden);
      clearInterval(timer);
    };
  }, [connected]);
}

function Shell() {
  useTerminalTheme(); // 登录后同步 Ghostty 配色到整个界面
  useUpdateCheck();
  const route = useRoute();
  const wide = useWide();
  const { overview } = useLive();
  const activePane = route.kind === "session" ? route.paneId : null;
  const activeFiles = route.kind === "files" ? route.projectId : null;

  // 切换页面时新页面带着方向进来，不生硬地跳过去：手机上从总览往里走从右边滑入，返回时总览从左边淡入；
  // 电脑上同级页面之间轻轻上浮。方向只在页面切换的那一刻算一次（动画 class 变了会重新播放），所以用 useMemo 钉住
  const pageKey = route.kind === "session" ? `s:${route.paneId}` : route.kind === "files" ? `f:${route.projectId}` : route.kind;
  const depth = route.kind === "overview" ? 0 : 1;
  const prevDepth = useRef(depth);
  const enter = useMemo(() => {
    const was = prevDepth.current;
    if (wide) return "motion-rise";
    return depth === 1 && was === 0 ? "motion-from-right" : depth === 0 && was === 1 ? "motion-from-left" : "motion-rise";
    // 只在页面（pageKey）切换时重新算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey, wide]);
  useEffect(() => {
    prevDepth.current = depth;
  });
  const content =
    route.kind === "session" ? (
      <SessionPage key={route.paneId} paneId={route.paneId} />
    ) : route.kind === "files" ? (
      <FilesPage key={route.projectId} projectId={route.projectId} path={route.path} />
    ) : route.kind === "ccswitch" ? (
      <CcSwitchPage section={route.section} />
    ) : route.kind === "devices" ? (
      <DevicesPage />
    ) : route.kind === "deepseek" ? (
      <DeepSeekPage />
    ) : route.kind === "terminal" ? (
      <TerminalOnlyPage paneId={route.paneId} />
    ) : null;
  const page = content && (
    <div key={pageKey} className={`flex min-h-0 min-w-0 flex-1 flex-col ${enter}`}>
      {content}
    </div>
  );

  // 左边始终保留 projdeck 导航；Harness 仅占用右侧内容区，切换其会话时保持同一个 iframe。
  const harnessView = route.kind === "harness" || (route.kind === "session" && route.paneId.startsWith("harness:"));
  // DeepSeek 原版前端启动要一两秒：进过一次就常驻（隐藏），之后进出、切换会话都不再重新启动。
  // 电脑上空闲时提前启动好，第一次打开也不用等。
  const [harnessMounted, setHarnessMounted] = useState(false);
  const harnessOnline = !!overview?.harness?.configured && !!overview.harness.online;
  useEffect(() => {
    if (harnessView) return setHarnessMounted(true);
    if (!wide || !harnessOnline || harnessMounted || route.kind === "terminal" || route.kind === "idle") return;
    const t = setTimeout(() => setHarnessMounted(true), 3_000);
    return () => clearTimeout(t);
  }, [harnessView, wide, harnessOnline, harnessMounted, route.kind]);
  const harness = (harnessMounted || harnessView) && (
    <HarnessPage active={harnessView} sessionId={route.kind === "session" && harnessView ? route.paneId.slice("harness:".length) : undefined} />
  );
  const details = harnessView ? null : page;

  // 左侧栏可折叠：折叠时收起，内容区占满，展开按钮回到交界处
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("projdeck-sidebar") === "collapsed");
  const toggleSidebar = () => setCollapsed((c) => {
    localStorage.setItem("projdeck-sidebar", c ? "open" : "collapsed");
    return !c;
  });

  // 手机原生端用 WebView 打开纯终端页时，不渲染 projdeck 的侧栏。
  if (route.kind === "terminal" || route.kind === "idle") return <div className="flex h-full min-h-0 flex-col">{content}</div>;

  if (wide) {
    return (
      <div className={cn("grid h-full", collapsed ? "grid-cols-[1fr]" : "grid-cols-[minmax(320px,380px)_1fr]")}>
        {/* 折叠时用条件渲染彻底移除侧栏，避免 hidden 类与 flex 冲突导致它仍被渲染、堆到内容区上方 */}
        {!collapsed && (
          <aside className="flex min-h-0 min-w-0 flex-col border-r">
            <Banner />
            <OverviewPage activePane={activePane} activeFiles={activeFiles} />
          </aside>
        )}
        <main className="relative flex min-h-0 min-w-0 flex-col">
          {harness}
          {!harnessView && (details ?? <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">选择一个会话</div>)}
          <button
            onClick={toggleSidebar}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            title={collapsed ? "展开侧栏" : "收起侧栏"}
            className={cn(
              "absolute top-3 z-30 flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:text-foreground",
              collapsed ? "left-2" : "-left-3",
            )}
          >
            {collapsed ? <PanelLeftOpenIcon className="size-3.5" /> : <PanelLeftCloseIcon className="size-3.5" />}
          </button>
        </main>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <Banner />
      {harness}
      {!harnessView && (details ?? <OverviewPage key={enter} activePane={null} activeFiles={null} enter={enter === "motion-from-left" ? enter : undefined} />)}
    </div>
  );
}
