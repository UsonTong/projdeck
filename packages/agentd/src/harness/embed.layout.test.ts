import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const browser = process.env.PROJDECK_TEST_CHROME || "/usr/bin/google-chrome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("嵌入布局保留零宽侧栏的 grid item，桌面与手机的聊天和输入框不能被挤到零宽", {
  skip: !existsSync(browser), timeout: 25_000,
}, async () => {
  const bridge = readFileSync(new URL("./embed.js", import.meta.url), "utf8");
  // 使用原版相同的三个自动排位 grid item；不加载用户配置，不访问真实 Harness 或模型。
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    *{box-sizing:border-box}body{margin:0}.frame{display:grid;height:600px;grid-template-rows:minmax(0,1fr) auto}
    .sidebar{border-right:1px solid black}.center{display:flex;min-width:0}.center textarea{width:100%;height:100px}
  </style></head><body>
  <div class="frame" data-rightbar-collapsed style="grid-template-columns:280px minmax(0px,1fr) minmax(0px,0px)">
    <div class="sidebar">navigation</div><div class="center"><textarea aria-label="chat"></textarea></div><div class="right"></div>
  </div><script>${bridge}</script><script>
    let selected=''; const listeners=new Set();
    const services={sessions:{list:{getSnapshot:()=>({phase:'ready',byId:{example:{}}}),subscribe:()=>()=>{}}},
      uiWorkspace:{openSession:id=>{selected=id;for(const f of listeners)f()},selection:{getSnapshot:()=>({sessionId:selected}),subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)}}},
      layout:{beginNavigation:()=>{}}};
    window.__ModuleLoader__={load:r=>{window.registration=r}};
    window.__ModuleLoader__.load=r=>{window.registration=r};
    window.__ModuleLoader__.load({id:'@deepseek-ai/dsh-client-ui-workspace',factory:()=>({apply:()=>{}})});
    window.registration.factory().apply({plugin:p=>p.apply({get:n=>services[n],effect:f=>f()})});
  </script></body></html>`;
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const dir = await mkdtemp(join(tmpdir(), "projdeck-grid-browser-"));
  const chrome = spawn(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let ws: WebSocket | undefined;
  try {
    let endpoint: URL | undefined;
    for (let i = 0; i < 80; i++) {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (match) { endpoint = new URL(match[1]!); break; }
      if (chrome.exitCode !== null) throw Error("浏览器启动失败");
      await sleep(100);
    }
    assert.ok(endpoint, "浏览器未提供调试端口");
    const targets = await (await fetch(`http://${endpoint.host}/json`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    ws = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(Error("调试连接失败")); });
    let next = 0;
    type Result = { result?: { value?: string } };
    const pending = new Map<number, (result: Result) => void>();
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id) { pending.get(msg.id)?.(msg.result); pending.delete(msg.id); }
    };
    const send = (method: string, params = {}) => new Promise<Result>((resolve) => {
      const id = ++next; pending.set(id, resolve); ws!.send(JSON.stringify({ id, method, params }));
    });
    await send("Page.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${address.port}/?embed=1&session=example` });
    for (let i = 0; i < 60; i++) {
      const result = await send("Runtime.evaluate", { expression: "document.documentElement.dataset.projdeckSession", returnByValue: true });
      if (result.result?.value === "example") break;
      await sleep(100);
    }
    for (const width of [1280, 390]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
      const result = await send("Runtime.evaluate", { returnByValue: true,
        expression: `JSON.stringify((()=>{const f=document.querySelector('.frame');const [s,c,r]=f.children;return{sidebar:s.getBoundingClientRect().width,center:c.getBoundingClientRect().width,right:r.getBoundingClientRect().width,input:c.querySelector('textarea').getBoundingClientRect().width,display:getComputedStyle(s).display}})())`,
      });
      const box = JSON.parse(result.result!.value!);
      assert.notEqual(box.display, "none", "侧栏必须保留自动排位的 grid item");
      assert.equal(box.sidebar, 0);
      assert.equal(box.right, 0, "空的右面板不能占据聊天轨道");
      assert.ok(box.center > width * 0.8, `聊天列被压缩：${JSON.stringify(box)}`);
      assert.ok(box.input > width * 0.7, `输入框被压缩：${JSON.stringify(box)}`);
    }
  } finally {
    ws?.close();
    chrome.kill("SIGTERM");
    await sleep(100);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
