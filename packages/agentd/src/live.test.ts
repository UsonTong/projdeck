import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { WebSocket } from "ws";
import type { HerdrClient } from "./herdr/client.ts";
import { LiveHub } from "./live.ts";
import type { ProjdeckService } from "./service.ts";

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: object[] = [];
  send(text: string): void { this.sent.push(JSON.parse(text)); }
  client(msg: object): void {
    this.emit("message", JSON.stringify(msg));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("watch → unwatch → watch 连发时只保留一套轮询", async () => {
  let calls = 0;
  let viewing = 0;
  const service = {
    overview: async () => ({ herdr: { online: true }, projects: [], unassigned: [], archived: [] }),
    transcript: async () => {
      calls++;
      return { conversationId: null, entries: [], cursor: -1, reset: false };
    },
    beginView: async () => {
      viewing++;
      return () => viewing--;
    },
  } as unknown as ProjdeckService;
  const hub = new LiveHub(service, new EventEmitter() as unknown as HerdrClient);
  const ws = new FakeWs();
  hub.add(ws as unknown as WebSocket);

  // React StrictMode 下前端会这样连发
  ws.client({ op: "watch", paneId: "p1" });
  ws.client({ op: "unwatch", paneId: "p1" });
  ws.client({ op: "watch", paneId: "p1" });
  await sleep(50);
  calls = 0;

  // 对话记录每 1.5s 轮询一次；若有两套轮询，这段时间会调用 2 次
  await sleep(1_700);
  // 被取消的那次 watch 也要结束「查看」，否则会话会一直被当成有人在看
  assert.equal(viewing, 1);
  ws.emit("close");
  assert.equal(calls, 1);
  assert.equal(viewing, 0);
});


test("Harness 原生订阅广播到多个客户端；重新配置后重建订阅且最后退出释放它", async () => {
  let subscriptions = 0;
  let releases = 0;
  let push: ((page: object) => void) | undefined;
  const service = {
    overview: async () => ({ herdr: { online: false }, harness: { configured: true, online: true }, projects: [], unassigned: [], archived: [] }),
    beginView: async () => () => {},
    transcript: async () => ({ conversationId: "id", entries: [], cursor: 1, reset: true }),
    watchTranscript: (_id: string, cb: (page: object) => void) => { subscriptions++; push = cb; return () => { releases++; }; },
  } as unknown as ProjdeckService;
  const hub = new LiveHub(service, new EventEmitter() as unknown as HerdrClient);
  const a = new FakeWs();
  const b = new FakeWs();
  hub.add(a as unknown as WebSocket);
  hub.add(b as unknown as WebSocket);
  try {
    a.client({ op: "watch", paneId: "harness:id" });
    b.client({ op: "watch", paneId: "harness:id" });
    await sleep(20);
    assert.equal(subscriptions, 1);
    const page = { conversationId: "id", entries: [{ kind: "assistant", id: "a", text: "实时增量" }], cursor: 2, reset: true };
    push!(page);
    for (const ws of [a, b]) assert.ok(JSON.stringify(ws.sent).includes("实时增量"));
    hub.reconnectHarness();
    await sleep(20);
    assert.equal(releases, 1);
    assert.equal(subscriptions, 2);
    a.client({ op: "unwatch", paneId: "harness:id" });
    assert.equal(releases, 1);
    b.client({ op: "unwatch", paneId: "harness:id" });
    assert.equal(releases, 2);
  } finally {
    a.emit("close");
    b.emit("close");
  }
});
