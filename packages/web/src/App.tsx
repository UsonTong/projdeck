import { TerminalSquareIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTerminalTheme } from "@/lib/terminalTheme";
import { api, authEvents } from "./api.ts";
import { ConfirmHost } from "./components/Confirm.tsx";
import { Login } from "./components/Login.tsx";
import { OverviewPage } from "./components/Overview.tsx";
import { CcSwitchPage } from "./components/CcSwitchPage.tsx";
import { DevicesPage } from "./components/DevicesPage.tsx";
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
    </TooltipProvider>
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
 * 没在操作这个页面（窗口没有焦点）时直接刷新；正在操作时只提示，不打断。未发送的草稿存在本地，刷新不会丢。
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
          if (!document.hasFocus()) return location.reload();
          toast("projdeck 有新版本", {
            id: "update",
            duration: Infinity,
            action: { label: "刷新", onClick: () => location.reload() },
          });
        }
      } catch {
        // 离线时下次再查
      }
    };
    void check();
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("blur", check);
    const timer = setInterval(check, 5 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("blur", check);
      clearInterval(timer);
    };
  }, [connected]);
}

function Shell() {
  useTerminalTheme(); // 登录后同步 Ghostty 配色到整个界面
  useUpdateCheck();
  const route = useRoute();
  const wide = useWide();
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
    ) : null;
  const page = content && (
    <div key={pageKey} className={`flex min-h-0 min-w-0 flex-1 flex-col ${enter}`}>
      {content}
    </div>
  );

  // 原版 Harness 自带侧栏，使用完整视口，避免两层侧栏挤在一起。
  if (route.kind === "harness" || (route.kind === "session" && route.paneId.startsWith("harness:"))) {
    return <div className="flex h-full min-h-0 flex-col"><HarnessPage /></div>;
  }

  if (wide) {
    return (
      <div className="grid h-full grid-cols-[minmax(320px,380px)_1fr]">
        <aside className="flex min-h-0 flex-col border-r">
          <Banner />
          <OverviewPage activePane={activePane} activeFiles={activeFiles} />
        </aside>
        <main className="flex min-h-0 min-w-0 flex-col">
          {page ?? <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">选择一个会话</div>}
        </main>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <Banner />
      {page ?? <OverviewPage key={enter} activePane={null} activeFiles={null} enter={enter === "motion-from-left" ? enter : undefined} />}
    </div>
  );
}
