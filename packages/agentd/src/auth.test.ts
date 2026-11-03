import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccessKey, AgentKeys } from "./auth.ts";
import { readJson } from "./config.ts";

const keyFile = (content: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "projdeck-key-")), "edge-key");
  writeFileSync(file, content);
  return file;
};

test("AccessKey：正确 key 通过，错误或缺失的不通过", () => {
  const k = new AccessKey(keyFile("TfmS4hR3qGC7FpmrR03Vb_test_key_xx\n"));
  assert.ok(k.enabled);
  assert.ok(k.valid("TfmS4hR3qGC7FpmrR03Vb_test_key_xx"));
  assert.ok(!k.valid("TfmS4hR3qGC7FpmrR03Vb_test_key_xy"));
  assert.ok(!k.valid(""));
  assert.ok(!k.valid(undefined));
});

test("AccessKey：文件不存在或 key 过短时不启用", () => {
  assert.ok(!new AccessKey("/nonexistent/edge-key").enabled);
  const short = new AccessKey(keyFile("abc"));
  assert.ok(!short.enabled);
  assert.ok(!short.valid("abc"));
});

test("AgentKeys：生成的密钥能通过校验，吊销后失效；文件里只存哈希", () => {
  const file = join(mkdtempSync(join(tmpdir(), "projdeck-agents-")), "agent-keys.json");
  const keys = new AgentKeys(file);
  const a = keys.issue("红米 K20 Pro");
  const b = keys.issue("realme");
  assert.ok(a.token.startsWith("pdagent_"));
  assert.notEqual(a.token, b.token);
  assert.equal(a.key.name, "红米 K20 Pro");
  assert.ok(keys.valid(a.token));
  assert.ok(keys.valid(b.token));
  assert.ok(!keys.valid("pdagent_wrong"));
  assert.ok(!keys.valid(undefined));

  const stored = readFileSync(file, "utf8");
  assert.ok(!stored.includes(a.token), "文件里不能出现明文密钥");
  assert.equal(readJson<unknown[]>(file, []).length, 2);

  assert.ok(keys.revoke(a.key.id));
  assert.ok(!keys.valid(a.token));
  assert.ok(keys.valid(b.token));
  assert.ok(!keys.revoke("no-such-id"));
  assert.deepEqual(new AgentKeys(file).list().map((k) => k.name), ["realme"]);
});
