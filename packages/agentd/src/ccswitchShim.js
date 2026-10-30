// 在 CC Switch 原版界面（编译后的前端）之前加载：替代 Tauri 的 window.__TAURI_INTERNALS__。
// 命令经 projdeck 转给电脑上正在运行的 CC Switch 执行（见 agentd 的 ccswitchBridge.ts），事件经 SSE 推回来。
// 会在电脑屏幕上弹东西的操作（文件选择框、打开文件夹、启动终端、窗口控制、重启……）不转发。
(() => {
  const callbacks = new Map();
  let nextCallback = 1;
  const transformCallback = (fn, once = false) => {
    const id = nextCallback++;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      return fn && fn(data);
    });
    return id;
  };
  const runCallback = (id, data) => callbacks.get(id)?.(data);

  // 轻提示（CC Switch 自己的提示组件拿不到）
  const notice = (text) => {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;border-radius:10px;" +
      "background:rgba(30,30,30,.92);color:#fff;font:13px system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.3);max-width:80vw";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  };
  const desktopOnly = () => {
    notice("这个操作会在电脑屏幕上打开窗口，请在电脑上的 CC Switch 里做");
    return null;
  };

  // ---- 事件：本地记录订阅，服务端用 SSE 推送 ----
  const listeners = new Map(); // eventId → { event, handler }
  const names = new Set();
  let nextEventId = 1;
  let source = null;
  const connectEvents = () => {
    source?.close();
    if (names.size === 0) return;
    source = new EventSource(`/api/ccswitch/events?e=${encodeURIComponent([...names].join(","))}`);
    source.onmessage = (m) => {
      const { event, payload } = JSON.parse(m.data);
      for (const [id, l] of listeners) if (l.event === event) runCallback(l.handler, { event, id, payload });
    };
  };
  let pendingConnect = null;
  const subscribe = (event) => {
    if (names.has(event)) return;
    names.add(event);
    // 启动时会连着订阅一批事件，合并成一次连接
    clearTimeout(pendingConnect);
    pendingConnect = setTimeout(connectEvents, 50);
  };

  const win = {
    is_maximized: false,
    is_minimized: false,
    is_fullscreen: false,
    is_focused: () => document.hasFocus(),
    is_visible: true,
    is_decorated: false,
    is_resizable: true,
    scale_factor: () => devicePixelRatio,
    inner_size: () => ({ width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio }),
    outer_size: () => ({ width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio }),
    theme: () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    title: () => document.title,
  };

  const local = {
    "plugin:event|listen": ({ event, handler }) => {
      const id = nextEventId++;
      listeners.set(id, { event, handler });
      subscribe(event);
      return id;
    },
    "plugin:event|unlisten": ({ eventId }) => void listeners.delete(eventId),
    "plugin:event|emit": () => null,
    "plugin:event|emit_to": () => null,
    "plugin:log|log": () => null,
    "plugin:updater|check": () => null,
    "plugin:process|exit": () => null,
    "plugin:process|restart": desktopOnly,
    "plugin:dialog|message": ({ message }) => (alert(message), "Ok"),
    "plugin:dialog|ask": ({ message }) => confirm(message),
    "plugin:dialog|confirm": ({ message }) => confirm(message),
    "plugin:dialog|open": desktopOnly,
    "plugin:dialog|save": desktopOnly,
    "plugin:opener|open_url": ({ url }) => void window.open(url, "_blank", "noopener"),
    open_external: ({ url }) => void window.open(url, "_blank", "noopener"),
    copy_text_to_clipboard: ({ text }) => navigator.clipboard.writeText(text).then(() => true),
    set_window_theme: () => null,
    tray_panel_action: () => null,
    tray_panel_hide: () => null,
    tray_panel_layout: () => null,
    tray_panel_placement: () => null,
    tray_panel_state: () => null,
  };
  for (const cmd of [
    "open_file_dialog",
    "open_zip_file_dialog",
    "save_file_dialog",
    "pick_directory",
    "open_app_config_folder",
    "open_config_folder",
    "open_cc_switch_skills_dir",
    "open_workspace_directory",
    "reveal_app_log_file",
    "reveal_backup_location",
    "reveal_session_path",
    "launch_session_terminal",
    "open_provider_terminal",
    "launch_hermes_dashboard",
    "open_hermes_web_ui",
    "restart_app",
    "install_update_and_restart",
    "open_portable_update_download",
  ])
    local[cmd] = desktopOnly;

  const invoke = async (cmd, args = {}) => {
    if (local[cmd]) return local[cmd](args);
    if (cmd.startsWith("plugin:window|") || cmd.startsWith("plugin:webview|")) {
      const v = win[cmd.slice(cmd.indexOf("|") + 1)];
      return typeof v === "function" ? v() : (v ?? null);
    }
    const r = await fetch("/api/ccswitch/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd, args }),
    });
    const body = await r.json().catch(() => ({}));
    // Tauri 命令出错时 Promise 以错误值（通常是一句说明）拒绝，这里保持一致
    if (!r.ok) throw body.error ?? `请求失败（${r.status}）`;
    return body.result ?? null;
  };

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback,
    callbacks,
    convertFileSrc: (path) => path,
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: {},
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, eventId) => listeners.delete(eventId) };
  window.isTauri = true;
})();
