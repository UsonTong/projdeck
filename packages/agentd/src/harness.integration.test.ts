import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ArchivedSession, Project, SessionStatus, TranscriptPage } from "@projdeck/shared";
import type { Config } from "./config.ts";
import type { HarnessBackend, HarnessSession } from "./harness/backend.ts";
import type { HerdrClient } from "./herdr/client.ts";
import { defaultArgs, type ProjectStore } from "./projects/store.ts";
import { ProjdeckService } from "./service.ts";

/** 不启动真实 Harness，不读用户配置/对话，不发送模型请求。 */
function fixture(herdrOnline = false) {
  const calls: string[] = [];
  const project: Project = { id: "project", name: "demo", path: "/tmp/demo", createdAt: "", archived: false, defaultAgent: "claude", agentArgs: defaultArgs };
  const archive: ArchivedSession[] = [];
  const state = { sticky: {} as Record<string, string>, hiddenTerminals: [] as string[], hiddenConversations: [] as string[], harnessDismissed: [] as string[], seenDone: [] as string[], harnessFresh: {} as Record<string, string> };
  const store = {
    projects: [project], archive, state, settings: { autoTrust: true, timeZone: null },
    getProject: (id: string) => { assert.equal(id, project.id); return project; },
    pruneTerminals: () => {}, updateSticky: () => {}, saveState: () => {}, saveArchive: () => {},
    isHidden: (id: string) => state.hiddenTerminals.includes(id),
    setHidden: (id: string, _conversation: string, on: boolean) => { state.hiddenTerminals = on ? [id] : []; },
    setSticky: (id: string, pid: string) => { state.sticky[id] = pid; },
    markDoneSeen: () => false,
  } as unknown as ProjectStore;
  const rows: HarnessSession[] = [{ id: "one", title: "Harness 历史", cwd: "/tmp/demo/src", status: "working", activeAt: 100 }];
  let created = 0;
  let online = true;
  const page: TranscriptPage = { conversationId: "one", cursor: 1, reset: true, entries: [{ kind: "assistant", id: "reply", text: "历史保留" }] };
  const harness: HarnessBackend = {
    status: () => ({ configured: true, online }),
    configure: async () => {}, close: () => {},
    list: async () => { if (!online) throw Error("offline"); return rows; },
    // 和真实 Harness 一样：新建的会话还没开始对话，标题为空、blank 为真，活动时间是创建时间
    create: async (cwd) => {
      calls.push("harness.create");
      const id = created++ ? `new${created}` : "new";
      rows.push({ id, title: "", cwd: cwd ?? "/tmp", status: "idle", activeAt: 1000 + created, blank: true });
      return id;
    },
    prompt: async (id, text) => { calls.push(`prompt:${id}:${text}`); },
    cancel: async (id) => { calls.push(`cancel:${id}`); },
    rename: async (id, title) => { rows.find((r) => r.id === id)!.title = title; },
    transcript: async () => page,
  };
  const herdr = Object.assign(new EventEmitter(), {
    listPanes: async () => { if (!herdrOnline) throw Error("herdr offline"); return []; },
    listAgents: async () => [], listWorkspaces: async () => [],
    createWorkspace: () => { throw Error("Harness 不得创建 herdr pane"); },
    createTab: () => { throw Error("Harness 不得创建 herdr tab"); },
    closePane: () => { throw Error("Harness 不得关闭 herdr pane"); },
    sendKeys: () => { throw Error("Harness 不得发送 PTY 按键"); },
  }) as unknown as HerdrClient;
  return { service: new ProjdeckService({} as Config, herdr, store, harness), store, calls, page, rows,
    offline: () => { online = false; }, setStatus: (s: SessionStatus) => { rows[0]!.status = s; } };
}

test("herdr 离线时 Harness 会话仍可列出、按目录归属项目，且没有终端能力", async () => {
  const { service } = fixture();
  const o = await service.overview();
  assert.equal(o.herdr.online, false);
  assert.equal(o.harness?.online, true);
  const s = o.projects[0]!.sessions[0]!;
  assert.equal(s.paneId, "harness:one");
  assert.equal(s.backend, "harness");
  assert.deepEqual(s.capabilities, { terminal: false, chat: true, keys: false });
  assert.deepEqual((await service.transcript(s.paneId, -1)).entries.map((e) => e.kind), ["assistant"]);
  const end = await service.beginView(s.paneId);
  end();
  await assert.rejects(service.terminalIdOf(s.paneId), /没有 herdr 终端/);
  await assert.rejects(service.keys(s.paneId, ["ctrl+c"]), /没有 herdr 终端/);
  await assert.rejects(service.moveBefore(s.paneId, null), /不能拖动 herdr 排序/);
});

test("创建/发消息/停止都直接走 Harness，不使用 agent.start 或 PTY", async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.startSession("project", "harness"), { paneId: "harness:new" });
  await service.prompt("harness:one", "继续");
  await service.cancel("harness:one");
  assert.deepEqual(calls, ["harness.create", "prompt:one:继续", "cancel:one"]);
});

test("Harness 本地归档/恢复保留原会话 ID，删除归档不会误重新导入", async () => {
  const { service, store, calls } = fixture();
  await service.setHidden("harness:one", true);
  await service.rename("harness:one", "新标题");
  assert.equal((await service.overview()).projects[0]!.sessions[0]!.title, "新标题");
  const archived = await service.archive("harness:one");
  assert.ok(calls.includes("cancel:one"));
  assert.equal((await service.overview()).projects[0]!.sessions.length, 0);
  assert.deepEqual(await service.restore(archived.id), { paneId: "harness:one" });
  assert.equal((await service.overview()).projects[0]!.sessions[0]!.hidden, true);
  const again = await service.archive("harness:one");
  service.deleteArchive(again.id);
  assert.ok(store.state.harnessDismissed.includes("one"));
  assert.equal((await service.overview()).projects[0]!.sessions.length, 0);
});

test("Harness 断线保留已知会话，不因后端短暂离线显示成对话已关闭", async () => {
  const { service, offline } = fixture(true);
  await service.overview();
  offline();
  const o = await service.overview();
  assert.equal(o.harness?.online, false);
  assert.equal(o.herdr.online, true);
  assert.equal(o.projects[0]!.sessions[0]!.paneId, "harness:one");
  assert.equal(o.projects[0]!.sessions[0]!.status, "unknown");
});

test("新建的 Harness 会话立即显示在最前面；未开始对话前再次新建复用它；其他空会话不显示", async () => {
  const { service, calls, rows } = fixture();
  // 原版启动时自动建的、以前新建后没用的空会话
  rows.push({ id: "stale", title: "", cwd: "/tmp/demo", status: "idle", activeAt: 5000, blank: true });
  assert.deepEqual((await service.overview()).projects[0]!.sessions.map((s) => s.paneId), ["harness:one"]);

  assert.deepEqual(await service.startSession("project", "harness"), { paneId: "harness:new" });
  let sessions = (await service.overview()).projects[0]!.sessions;
  assert.deepEqual(sessions.map((s) => s.paneId), ["harness:new", "harness:one"]);
  assert.equal(sessions[0]!.title, "新对话");

  // 还没开始对话：再点新建打开的是同一个，不再多建
  assert.deepEqual(await service.startSession("project", "harness"), { paneId: "harness:new" });
  assert.equal(calls.filter((c) => c === "harness.create").length, 1);

  // 开始对话后就是普通会话，再新建才会建新的
  Object.assign(rows.find((r) => r.id === "new")!, { blank: false, title: "第一句话" });
  await service.overview();
  assert.deepEqual(await service.startSession("project", "harness"), { paneId: "harness:new2" });
  sessions = (await service.overview()).projects[0]!.sessions;
  assert.deepEqual(sessions.map((s) => s.paneId), ["harness:new2", "harness:new", "harness:one"]);
});
