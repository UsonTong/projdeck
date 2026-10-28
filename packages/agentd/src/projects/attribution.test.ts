import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute, isWithin, matchProject } from "./attribution.ts";

const projects = [
  { id: "a", path: "/home/u/Projects/a" },
  { id: "ab", path: "/home/u/Projects/a/b" },
  { id: "wx", path: "/home/u/Repositories/wx-monitor" },
];

test("isWithin 按路径段比较", () => {
  assert.ok(isWithin("/x/a", "/x/a"));
  assert.ok(isWithin("/x/a/sub", "/x/a"));
  assert.ok(isWithin("/x/a/sub", "/x/a/"));
  assert.ok(!isWithin("/x/ab", "/x/a"));
});

test("matchProject 取最长前缀", () => {
  assert.equal(matchProject("/home/u/Projects/a/b/src", projects), "ab");
  assert.equal(matchProject("/home/u/Projects/a/c", projects), "a");
  assert.equal(matchProject("/home/u", projects), null);
});

test("attribute：cwd 匹配、sticky、同 workspace 兜底", () => {
  const panes = [
    { terminalId: "t1", workspaceId: "w1", cwd: "/home/u/Repositories/wx-monitor" },
    // 临时终端 cd 到了 /tmp，但与 t1 同 workspace
    { terminalId: "t2", workspaceId: "w1", cwd: "/tmp" },
    // 曾在项目 a 中，后来 cd 走了
    { terminalId: "t3", workspaceId: "w2", cwd: "/home/u" },
    // 随手在 ~ 开的
    { terminalId: "t4", workspaceId: "w3", cwd: "/home/u" },
  ];
  const { assignments, newSticky } = attribute(panes, projects, { t3: "a" });
  assert.equal(assignments.get("t1"), "wx");
  assert.equal(assignments.get("t2"), "wx");
  assert.equal(assignments.get("t3"), "a");
  assert.equal(assignments.get("t4"), null);
  assert.deepEqual(newSticky, { t1: "wx", t2: "wx", t3: "a" });
});

test("attribute：sticky 指向已删除的项目时重新匹配", () => {
  const panes = [{ terminalId: "t1", workspaceId: "w1", cwd: "/home/u/Projects/a" }];
  const { assignments } = attribute(panes, projects, { t1: "deleted" });
  assert.equal(assignments.get("t1"), "a");
});

test("attribute：workspace 跨多个项目时不兜底", () => {
  const panes = [
    { terminalId: "t1", workspaceId: "w1", cwd: "/home/u/Projects/a" },
    { terminalId: "t2", workspaceId: "w1", cwd: "/home/u/Repositories/wx-monitor" },
    { terminalId: "t3", workspaceId: "w1", cwd: "/tmp" },
  ];
  const { assignments } = attribute(panes, projects, {});
  assert.equal(assignments.get("t3"), null);
});
