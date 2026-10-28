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
  send(): void {}
  client(msg: object): void {
    this.emit("message", JSON.stringify(msg));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("watch → unwatch → watch 连发时只保留一套轮询", async () => {
  let calls = 0;
  const service = {
    overview: async () => ({ herdr: { online: true }, projects: [], unassigned: [], archived: [] }),
    transcript: async () => {
      calls++;
      return { conversationId: null, entries: [], cursor: -1, reset: false };
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
  ws.emit("close");
  assert.equal(calls, 1);
});
