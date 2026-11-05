import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PresentStore } from "./present.ts";

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "projdeck-present-"));
  const png = join(dir, "image.png");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const text = join(dir, "notes.txt");
  writeFileSync(text, "hi");
  return { dir, png, text };
};

test("只接受已登记目录里的图片，并能取回同一文件", () => {
  const { dir, png, text } = setup();
  const store = new PresentStore();
  const item = store.add(png, "截图", [dir]);
  assert.equal(item.title, "截图");
  assert.equal(item.mime, "image/png");
  assert.equal(store.get(item.id)?.path.endsWith("image.png"), true);
  assert.equal(store.list()[0]?.id, item.id);
  assert.throws(() => store.add(text, undefined, [dir]), /只支持/);
  assert.throws(() => store.add(join(dir, "missing.png"), undefined, [dir]), /不存在/);
  assert.throws(() => store.add("/etc/hostname", undefined, [dir]), /只能展示/);
});
