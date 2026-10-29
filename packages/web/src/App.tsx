import { TerminalSquareIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useState } from "react";
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

function Shell() {
  useTerminalTheme(); // 登录后同步 Ghostty 配色到整个界面
  const route = useRoute();
  const wide = useWide();
  const activePane = route.kind === "session" ? route.paneId : null;
  const activeFiles = route.kind === "files" ? route.projectId : null;

  const page =
    route.kind === "session" ? (
      <SessionPage key={route.paneId} paneId={route.paneId} />
    ) : route.kind === "files" ? (
      <FilesPage key={route.projectId} projectId={route.projectId} path={route.path} />
    ) : null;

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
      {page ?? <OverviewPage activePane={null} activeFiles={null} />}
    </div>
  );
}
