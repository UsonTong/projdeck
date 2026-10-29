import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { checkName, deleteEntry, listDir, makeDir, renameEntry, resolveInProject, saveToDir } from "./files.ts";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "projdeck-files-"));
  const root = join(base, "proj");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "x");
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(base, "outside.txt"), "outside");
  symlinkSync(join(base, "outside.txt"), join(root, "escape-link"));
  symlinkSync(join(root, "src"), join(root, "src-link"));
  return { base, root };
}

test("resolveInProject：拒绝 .. 和指向项目外的软链接", async () => {
  const { root } = setup();
  assert.ok((await resolveInProject(root, "src/a.ts")).endsWith("src/a.ts"));
  assert.ok((await resolveInProject(root, "src-link/a.ts")).endsWith("src/a.ts")); // 项目内的软链接可以
  await assert.rejects(resolveInProject(root, "../outside.txt"), /不在项目内/);
  await assert.rejects(resolveInProject(root, "src/../../outside.txt"), /不在项目内/);
  await assert.rejects(resolveInProject(root, "escape-link"), /不在项目内/);
  await assert.rejects(resolveInProject(root, "/etc/passwd"), /不存在/); // 绝对路径按项目内相对路径处理
  await assert.rejects(resolveInProject(root, "nope.txt"), /不存在/);
});

test("listDir：文件夹在前，默认不显示隐藏文件", async () => {
  const { root } = setup();
  const r = await listDir(root, "", false);
  assert.deepEqual(r.entries.map((e) => `${e.type}:${e.name}`), ["dir:src", "dir:src-link", "file:escape-link"]);
  const all = await listDir(root, "", true);
  assert.ok(all.entries.some((e) => e.name === ".env"));
  await assert.rejects(listDir(root, "..", false), /不在项目内/);
});

test("saveToDir：保留原名，重名自动编号，文件名去掉路径", async () => {
  const { root } = setup();
  const up = (name: string) => saveToDir(root, "src", name, Readable.from([Buffer.from("data")]));
  assert.equal((await up("报告.pdf")).name, "报告.pdf");
  assert.equal((await up("报告.pdf")).name, "报告 (1).pdf");
  assert.equal((await up("../../evil.sh")).name, "evil.sh");
  assert.equal(readFileSync(join(root, "src", "evil.sh"), "utf8"), "data");
});

test("新建 / 重命名 / 删除", async () => {
  const { root, base } = setup();
  await makeDir(root, "", "docs");
  await assert.rejects(makeDir(root, "", "docs"), /已存在/);
  await assert.rejects(makeDir(root, "", "../x"), /文件名无效/);
  await renameEntry(root, "docs", "文档");
  await assert.rejects(renameEntry(root, "", "x"), /根目录/);
  await deleteEntry(root, "文档");
  await assert.rejects(deleteEntry(root, ""), /根目录/);
  await assert.rejects(deleteEntry(root, "."), /根目录/);
  // 删除指向项目外的软链接：只删链接本身，目标文件保留
  await deleteEntry(root, "escape-link");
  assert.equal(readFileSync(join(base, "outside.txt"), "utf8"), "outside");
  assert.throws(() => checkName("a/b"), /文件名无效/);
});
