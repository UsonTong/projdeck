import { useEffect, useState } from "react";
import { api, authEvents } from "./api.ts";
import { Login } from "./components/Login.tsx";
import { OverviewPage } from "./components/Overview.tsx";
import { SessionPage } from "./components/Session.tsx";
import { ToastHost } from "./components/Toast.tsx";
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

  if (auth === "loading") return <div className="splash">projdeck</div>;
  if (auth === "out") return <Login configured={configured} onSuccess={() => setAuth("in")} />;
  return <Shell />;
}

function Shell() {
  const paneId = useRoute();
  const wide = useWide();
  const { overview, connected } = useLive();

  const banner = !connected ? (
    <div className="banner warn">与本地电脑的连接已断开，正在重连…</div>
  ) : overview && !overview.herdr.online ? (
    <div className="banner warn">herdr 未运行：{overview.herdr.error}</div>
  ) : null;

  if (wide) {
    return (
      <div className="layout-wide">
        <aside className="sidebar">
          {banner}
          <OverviewPage activePane={paneId} />
        </aside>
        <main className="main">
          {paneId ? <SessionPage key={paneId} paneId={paneId} /> : <div className="empty-main">选择一个会话</div>}
        </main>
        <ToastHost />
      </div>
    );
  }
  return (
    <div className="layout-narrow">
      {banner}
      {paneId ? <SessionPage key={paneId} paneId={paneId} /> : <OverviewPage activePane={null} />}
      <ToastHost />
    </div>
  );
}
