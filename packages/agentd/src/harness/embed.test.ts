import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("./embed.js", import.meta.url), "utf8");
function fixture(standalone = false, href = "http://127.0.0.1:7420/harness/?embed=1&session=beta") {
  const sent: Record<string, unknown>[] = [];
  const opened: string[] = [];
  let registration: { factory: () => { apply(ctx: object): void } } | undefined;
  const listeners = new Map<string, (e: { source: unknown; origin: string; data: unknown }) => void>();
  let selected = "";
  const selectListeners = new Set<() => void>();
  const listListeners = new Set<() => void>();
  const timers = new Set<() => void>();
  const storage = new Map<string, string>();
  const cleanups: (() => void)[] = [];
  const sessions = { list: {
    getSnapshot: () => ({ phase: "ready", byId: { alpha: {}, beta: {} } }),
    subscribe: (cb: () => void) => { listListeners.add(cb); return () => listListeners.delete(cb); },
  } };
  const workspace = {
    openSession: (id: string) => { opened.push(id); selected = id; for (const cb of selectListeners) cb(); },
    selection: { getSnapshot: () => ({ sessionId: selected }), subscribe: (cb: () => void) => { selectListeners.add(cb); return () => selectListeners.delete(cb); } },
  };
  let navigations = 0;
  const services: Record<string, unknown> = { sessions, uiWorkspace: workspace, layout: { beginNavigation: () => { navigations++; } } };
  const ctx = { plugin: (plugin: { inject: string[]; apply(ctx: object): void }) => {
    assert.deepEqual([...plugin.inject], ["uiWorkspace", "sessions", "layout"]);
    plugin.apply({ get: (key: string) => services[key], effect: (f: () => () => void) => { cleanups.push(f()); } });
  } };
  const frame = { style: { gridTemplateColumns: "280px minmax(0px, 1fr) minmax(0px, 320px)" }, setAttribute: () => {} };
  const document = { documentElement: { dataset: {} as Record<string, string> }, head: { append: () => {} }, body: {},
    querySelector: () => frame, createElement: () => ({ textContent: "", remove: () => {} }),
  };
  const window = {
    parent: {} as object,
    __ModuleLoader__: undefined as unknown,
    postMessage: (m: Record<string, unknown>) => sent.push(m),
    addEventListener: (name: string, cb: (e: { source: unknown; origin: string; data: unknown }) => void) => { listeners.set(name, cb); },
    removeEventListener: (name: string) => { listeners.delete(name); },
  };
  window.parent = standalone ? window : { postMessage: (m: Record<string, unknown>) => sent.push(m) };
  runInNewContext(source, { window, document, location: { origin: "http://127.0.0.1:7420", href }, URL,
    localStorage: { setItem: (k: string, v: string) => storage.set(k, v) },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (cb: () => void) => { timers.add(cb); return cb; }, clearTimeout: (cb: () => void) => timers.delete(cb),
  });
  window.__ModuleLoader__ = { load: () => { throw Error("预加载阶段不应直接运行插件"); } };
  const loader = window.__ModuleLoader__ as { load(row: object): void };
  // 模拟原版从 bootstrap 队列切换为 live 模式，确保导航适配不会随 load 替换而丢失。
  loader.load = (row) => { registration = row as typeof registration; };
  loader.load({ id: "@deepseek-ai/dsh-client-ui-workspace", factory: () => ({ apply: () => {} }) });
  registration!.factory().apply(ctx);
  return { opened, sent, frame, document, storage, navigations: () => navigations,
    select: (id: string, commandId: number, origin = "http://127.0.0.1:7420", parent: object = window.parent) => listeners.get("message")!({ source: parent, origin, data: { channel: "projdeck-harness", type: "select", sessionId: id, commandId } }),
    /** 原版自己改了选中项（例如启动时恢复上次看的会话）。 */
    dshSelects: (id: string) => { selected = id; for (const cb of selectListeners) cb(); },
    runTimers: () => { const due = [...timers]; timers.clear(); for (const cb of due) cb(); },
    cleanup: () => { for (const f of cleanups) f(); assert.equal(timers.size, 0); },
  };
}

test("嵌入桥在模块加载器切换阶段后仍生效，按公开服务精确选中会话并保留右面板宽度", () => {
  const f = fixture();
  try {
    assert.ok(f.sent.some(m => m.type === "ready"));
    f.select("alpha", 1);
    f.select("beta", 2);
    assert.deepEqual(f.opened, ["alpha", "beta"]);
    assert.equal(f.document.documentElement.dataset.projdeckSession, "beta");
    assert.equal(f.frame.style.gridTemplateColumns, "0px minmax(0px, 1fr) minmax(0px, 320px)");
    assert.equal(f.navigations(), 2);
    assert.ok(f.sent.some(m => m.type === "selected" && m.sessionId === "beta" && m.commandId === 2));
  } finally { f.cleanup(); }
});

test("桥接拒绝外站或非父窗口的选择消息，不会打开不存在的会话", () => {
  const f = fixture();
  try {
    f.select("alpha", 1, "https://evil.invalid");
    f.select("alpha", 2, "http://127.0.0.1:7420", {});
    f.select("missing", 3);
    assert.deepEqual(f.opened, []);
  } finally { f.cleanup(); }
});

test("安卓顶层 WebView 使用 session 参数直接打开同一会话，不需要 JS bridge", () => {
  const f = fixture(true);
  try {
    assert.deepEqual(f.opened, ["beta"]);
    assert.equal(f.document.documentElement.dataset.projdeckSession, "beta");
  } finally { f.cleanup(); }
});

test("原版启动前把 URL 里的目标会话写入它记住的选中项，避免先恢复成上次看的会话", () => {
  const f = fixture(false);
  try {
    assert.equal(f.storage.get("dsh.sessions.current"), JSON.stringify({ sessionId: "beta" }));
  } finally { f.cleanup(); }
  const none = fixture(false, "http://127.0.0.1:7420/harness/?embed=1");
  try { assert.equal(none.storage.size, 0); } finally { none.cleanup(); }
});

test("切换后原版又把选中项改回上次的会话：改回目标会话，且不把临时的选中项报告给父页面", () => {
  const f = fixture();
  try {
    f.select("beta", 1);
    const reported = f.sent.length;
    f.dshSelects("alpha");
    assert.ok(!f.sent.slice(reported).some((m) => m.type === "selected" && m.sessionId === "alpha"));
    f.runTimers();
    assert.deepEqual(f.opened, ["beta", "beta"]);
    assert.equal(f.document.documentElement.dataset.projdeckSession, "beta");
  } finally { f.cleanup(); }
});
