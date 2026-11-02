import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeProjectDirName, parseClaudeRecords } from "./claude.ts";
import { matchCodexRollouts, parseCodexRecords } from "./codex.ts";
import { readJsonl } from "./jsonl.ts";
import { parsePiRecords, piSessionDirName, piSessionId } from "./pi.ts";

test("claudeProjectDirName 把非字母数字替换为 -", () => {
  assert.equal(claudeProjectDirName("/home/yl/Repositories"), "-home-yl-Repositories");
  assert.equal(claudeProjectDirName("/tmp/a_b.c"), "-tmp-a-b-c");
});

test("parseClaudeRecords：用户消息、图片、助手文本、工具调用", () => {
  const entries = parseClaudeRecords([
    { type: "mode", sessionId: "s" },
    {
      type: "user",
      uuid: "u1",
      message: { role: "user", content: [{ type: "text", text: "[Image #1]看看这张图" }, { type: "image" }] },
    },
    { type: "user", uuid: "u2", isMeta: true, message: { content: [{ type: "text", text: "[Image: source: /p/.uploads/a.png]" }] } },
    {
      type: "assistant",
      uuid: "a1",
      message: {
        content: [
          { type: "thinking" },
          { type: "text", text: "好的" },
          { type: "tool_use", id: "t", name: "Bash", input: { command: "ls -la", description: "列出文件" } },
        ],
      },
    },
    { type: "user", uuid: "u3", message: { content: [{ type: "tool_result" }] } },
    { type: "assistant", uuid: "a2", isSidechain: true, message: { content: [{ type: "text", text: "子代理" }] } },
  ]);
  assert.deepEqual(
    entries.map((e) => [e.kind, "text" in e ? e.text : e.summary]),
    [
      ["user", "看看这张图"],
      ["assistant", "好的"],
      ["tool", "列出文件"],
    ],
  );
  assert.deepEqual((entries[0] as { images: string[] }).images, ["/p/.uploads/a.png"]);
});

test("parseCodexRecords：跳过注入的上下文消息", () => {
  const entries = parseCodexRecords(
    [
      { type: "session_meta", payload: { id: "x", cwd: "/p" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>..." }] } },
      { type: "response_item", payload: { type: "message", role: "user", id: "m1", content: [{ type: "input_text", text: "修一下 bug" }] } },
      { type: "response_item", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: '{"command":["rg","foo"]}' } },
      { type: "response_item", payload: { type: "message", role: "assistant", id: "m2", content: [{ type: "output_text", text: "已修复" }] } },
      { type: "response_item", payload: { type: "reasoning" } },
    ],
    0,
  );
  assert.deepEqual(
    entries.map((e) => [e.kind, "text" in e ? e.text : e.summary]),
    [
      ["user", "修一下 bug"],
      ["tool", "rg foo"],
      ["assistant", "已修复"],
    ],
  );
});

test("matchCodexRollouts：同目录按修改时间依次分配", () => {
  const r = (threadId: string, cwd: string, mtimeMs: number) => ({ file: threadId, threadId, cwd, mtimeMs });
  const m = matchCodexRollouts(
    [
      { terminalId: "t1", cwd: "/a" },
      { terminalId: "t2", cwd: "/a" },
      { terminalId: "t3", cwd: "/b" },
    ],
    [r("old", "/a", 1), r("new", "/a", 3), r("mid", "/a", 2)],
  );
  assert.equal(m.get("t1")?.threadId, "new");
  assert.equal(m.get("t2")?.threadId, "mid");
  assert.equal(m.has("t3"), false);
});

test("readJsonl：增量读取只消费完整行，截断后重置", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "projdeck-")), "t.jsonl");
  writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":');
  const first = await readJsonl(file, -1);
  assert.deepEqual(first.records, [{ a: 1 }, { a: 2 }]);
  appendFileSync(file, '3}\n{"a":4}\n');
  const second = await readJsonl(file, first.cursor);
  assert.deepEqual(second.records, [{ a: 3 }, { a: 4 }]);
  assert.equal(second.reset, false);
  writeFileSync(file, '{"b":1}\n');
  const third = await readJsonl(file, second.cursor);
  assert.equal(third.reset, true);
  assert.deepEqual(third.records, [{ b: 1 }]);
});

test("piSessionId：路径取出会话 id，裸 id 原样返回", () => {
  assert.equal(piSessionId("/h/.pi/agent/sessions/--x--/2026-11-02T13-13-27-569Z_01a19c64-b310-7127-8db0-72fd2e34693f.jsonl"), "01a19c64-b310-7127-8db0-72fd2e34693f");
  assert.equal(piSessionId("abc"), "abc");
  assert.equal(piSessionId(undefined), null);
});

test("piSessionDirName：去掉开头的分隔符，/ \\ : 换成 -，两头加 --", () => {
  assert.equal(piSessionDirName("/home/yl/Workspaces/threads-follow-assistant"), "--home-yl-Workspaces-threads-follow-assistant--");
  assert.equal(piSessionDirName("C:\\work\\a"), "--C--work-a--");
});

test("parsePiRecords：用户、助手文本、工具调用；系统消息、思考、工具结果不显示", () => {
  const entries = parsePiRecords([
    { type: "session", id: "s", cwd: "/p" },
    { type: "model_change", id: "m1", modelId: "x" },
    { type: "message", id: "sys", message: { role: "system", content: "", sections: { preamble: "..." } } },
    { type: "message", id: "u1", timestamp: "2026-10-16T04:40:49.000Z", message: { role: "user", content: [{ type: "text", text: "你好" }] } },
    { type: "message", id: "u2", message: { role: "user", content: "纯字符串也行" } },
    {
      type: "message",
      id: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "想想" },
          { type: "text", text: "先看看文件" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } },
        ],
      },
    },
    { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "total 0" }], isError: false } },
  ]);
  assert.deepEqual(
    entries.map((e) => [e.kind, e.id]),
    [
      ["user", "u1"],
      ["user", "u2"],
      ["assistant", "a1:1"],
      ["tool", "a1:2"],
    ],
  );
  assert.equal(entries[0]!.kind === "user" && entries[0]!.text, "你好");
  const tool = entries[3]!;
  assert.ok(tool.kind === "tool" && tool.name === "bash" && tool.summary.includes("ls -la"));
});
