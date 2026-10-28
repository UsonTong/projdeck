import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeProjectDirName, parseClaudeRecords } from "./claude.ts";
import { matchCodexRollouts, parseCodexRecords } from "./codex.ts";
import { readJsonl } from "./jsonl.ts";

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
