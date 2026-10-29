import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccessKey } from "./auth.ts";

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
