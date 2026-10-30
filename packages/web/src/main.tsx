import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service Worker：推送通知、连不上电脑时的提示页（见 public/sw.js）。开发模式下不注册，免得缓存干扰热更新
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js");
  // 点了通知、而 projdeck 已经开着：由 Service Worker 通知这里打开对应会话
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent<{ type?: string; url?: string }>) => {
    if (e.data?.type === "open" && e.data.url) location.hash = new URL(e.data.url).hash;
  });
}
