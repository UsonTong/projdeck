import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopFocus } from "./desktopFocus.ts";

const ev = (o: object) => JSON.stringify(o);
const win = (id: number, app_id: string, is_focused = false) => ({ id, app_id, is_focused, title: "", pid: 1, workspace_id: 1 });

test("Ghostty 窗口获得焦点时记录时间，其他窗口不算", () => {
  const f = new DesktopFocus();
  let changes = 0;
  f.on("change", () => changes++);
  f.handle(ev({ WindowsChanged: { windows: [win(1, "com.mitchellh.ghostty"), win(2, "google-chrome", true)] } }));
  assert.equal(f.focusedAt, 0); // 初始聚焦的是浏览器

  f.handle(ev({ WindowFocusChanged: { id: 1 } }));
  assert.ok(f.focusedAt > 0);
  assert.equal(changes, 1);

  // 仍在 Ghostty 内（同一窗口再次报告）不重复触发
  const at = f.focusedAt;
  f.handle(ev({ WindowFocusChanged: { id: 1 } }));
  assert.equal(changes, 1);
  assert.equal(f.focusedAt, at);

  // 切到浏览器、桌面空白（null），都不算
  f.handle(ev({ WindowFocusChanged: { id: 2 } }));
  f.handle(ev({ WindowFocusChanged: { id: null } }));
  assert.equal(changes, 1);

  // 新开的 Ghostty 窗口直接获得焦点
  f.handle(ev({ WindowOpenedOrChanged: { window: win(3, "com.mitchellh.ghostty", true) } }));
  assert.equal(changes, 2);
});

test("无法解析的行被忽略", () => {
  const f = new DesktopFocus();
  f.handle("not json");
  f.handle(ev({ KeyboardLayoutsChanged: {} }));
  assert.equal(f.focusedAt, 0);
});
