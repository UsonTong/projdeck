import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { checkName, deleteEntry, listDir, makeDir, readForEdit, renameEntry, resolveInProject, saveToDir, writeText } from "./files.ts";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";

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

test("编辑保存：检查打开之后是否被改过，保留权限，确认后可覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "projdeck-edit-"));
  const file = join(root, "a.sh");
  await writeFile(file, "echo 1\n", { mode: 0o755 });
  const opened = await readForEdit(root, "a.sh");
  assert.equal(opened.text, "echo 1\n");

  const saved = await writeText(root, "a.sh", "echo 2\n", opened.mtimeMs);
  assert.equal(await readFile(file, "utf8"), "echo 2\n");
  assert.equal((await stat(file)).mode & 0o777, 0o755);
  // 没有遗留临时文件
  assert.deepEqual((await readdir(root)).sort(), ["a.sh"]);

  // 别人（agent）在此期间改了文件：用旧的修改时间保存会被拒绝
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(file, "echo agent\n");
  await assert.rejects(writeText(root, "a.sh", "echo 3\n", saved.mtimeMs), (e: { statusCode?: number }) => e.statusCode === 409);
  assert.equal(await readFile(file, "utf8"), "echo agent\n");
  // 确认覆盖
  await writeText(root, "a.sh", "echo 3\n", null);
  assert.equal(await readFile(file, "utf8"), "echo 3\n");

  // 二进制文件不能编辑；项目外不能写
  await writeFile(join(root, "b.bin"), Buffer.from([1, 0, 2]));
  await assert.rejects(readForEdit(root, "b.bin"), (e: { statusCode?: number }) => e.statusCode === 415);
  await assert.rejects(writeText(root, "../x", "", null), (e: { statusCode?: number }) => e.statusCode === 403 || e.statusCode === 404);
  await rm(root, { recursive: true });
});
