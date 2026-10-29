import assert from "node:assert/strict";
import { test } from "node:test";
import { isImagePath, safeFileName } from "./uploads.ts";

test("safeFileName：保留中文与扩展名，去掉路径、空格和特殊字符", () => {
  assert.equal(safeFileName("需求文档 v2.pdf", "application/pdf"), "需求文档_v2.pdf");
  assert.equal(safeFileName("../../etc/passwd", "text/plain"), "passwd");
  assert.equal(safeFileName("C:\\Users\\me\\report (final).xlsx", ""), "report_final_.xlsx");
  assert.equal(safeFileName(".env", "text/plain"), "env");
  assert.equal(safeFileName("a;rm -rf $HOME`.sh", ""), "a_rm_-rf_HOME_.sh");
});

test("safeFileName：没有文件名时按类型补扩展名", () => {
  assert.equal(safeFileName("", "image/png"), "file.png");
  assert.equal(safeFileName("image", "image/jpeg"), "image.jpg");
  assert.equal(safeFileName("", "application/octet-stream"), "file");
});

test("safeFileName：超长文件名保留结尾（含扩展名）", () => {
  const name = safeFileName(`${"x".repeat(200)}.log`, "");
  assert.equal(name.length, 80);
  assert.ok(name.endsWith(".log"));
});

test("isImagePath", () => {
  assert.ok(isImagePath("/p/.uploads/a.PNG"));
  assert.ok(!isImagePath("/p/.uploads/a.pdf"));
});
