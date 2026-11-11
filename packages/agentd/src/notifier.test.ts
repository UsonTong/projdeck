import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Overview, Session } from "@projdeck/shared";
import type { HerdrClient } from "./herdr/client.ts";
import { Notifier } from "./notifier.ts";
import type { PushPayload, PushService } from "./push.ts";
import type { ProjdeckService } from "./service.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function session(paneId: string, status: Session["status"]): Session {
  return { paneId, terminalId: `t-${paneId}`, workspaceId: "w", kind: "claude", status, title: paneId, cwd: "/", conversationId: null, hidden: false, order: 0, activeAt: null };
}

/** 依次返回给定的总览；sent 记录推送的内容。 */
function setup(frames: { unassigned: Session[]; mutedProject?: Session[] }[]) {
  let i = 0;
  const sent: PushPayload[] = [];
  const service = {
    refresh: async () => {
      const f = frames[Math.min(i++, frames.length - 1)]!;
      const overview = {
        herdr: { online: true },
        projects: f.mutedProject ? [{ id: "p", name: "P", notify: false, sessions: f.mutedProject }] : [],
        unassigned: f.unassigned,
      } as unknown as Overview;
      return { overview };
    },
    lastReply: async () => "最后一句",
    isViewed: () => false,
  } as unknown as ProjdeckService;
  const push = { count: 1, send: async (p: PushPayload) => void sent.push(p) } as unknown as PushService;
  const herdr = new EventEmitter() as unknown as HerdrClient;
  const notifier = new Notifier(service, herdr, push);
  const tick = async () => {
    await (notifier as unknown as { check(): Promise<void> }).check();
    await sleep(5);
  };
  return { notifier, sent, tick };
}

test("工作中 → 已完成时通知，附上最后一句回复；第一次看到不通知", async () => {
  const { sent, tick } = setup([
    { unassigned: [session("a", "done")] }, // 刚启动：已经是完成，不通知
    { unassigned: [session("a", "working")] },
    { unassigned: [session("a", "done")] },
  ]);
  await tick();
  await tick();
  assert.equal(sent.length, 0);
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.title, /完成了/);
  assert.match(sent[0]!.body, /最后一句/);
  assert.equal(sent[0]!.url, "/#/s/a");
});

test("需处理持续 3 秒才通知；很快被处理掉（如自动信任）就不通知", async () => {
  const { sent, tick } = setup([
    { unassigned: [session("a", "working"), session("b", "working")] },
    { unassigned: [session("a", "blocked"), session("b", "blocked")] },
    { unassigned: [session("a", "working"), session("b", "blocked")] }, // a 立刻恢复
  ]);
  await tick();
  await tick();
  await tick();
  assert.equal(sent.length, 0);
  await sleep(3_100);
  assert.deepEqual(
    sent.map((s) => s.tag),
    ["b"],
  );
  assert.match(sent[0]!.title, /需要你处理/);
});

test("关掉通知的项目不通知", async () => {
  const { sent, tick } = setup([{ unassigned: [], mutedProject: [session("m", "working")] }, { unassigned: [], mutedProject: [session("m", "done")] }]);
  await tick();
  await tick();
  assert.equal(sent.length, 0);
});

test("DeepSeek Harness 完成（working → idle）也通知，因为它没有 done 状态", async () => {
  const harness = (status: Session["status"]) => ({ ...session("dsh", status), kind: "harness" as const });
  const { sent, tick } = setup([
    { unassigned: [harness("working")] },
    { unassigned: [harness("idle")] },
  ]);
  await tick();
  assert.equal(sent.length, 0); // 第一次看到 working，不通知
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.title, /DeepSeek 完成了/);
});
