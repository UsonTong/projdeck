import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGhosttyConfig } from "./ghosttyTheme.ts";

// 节选自真实的 `ghostty +show-config`（dankcolors 主题，font-size = 12）
const sample = `font-family =
font-family-bold =
font-size = 12
theme = dankcolors
background = #0c0e12
foreground = #e1e6ef
selection-foreground = #e1e6ef
selection-background = #395571
palette = 0=#0c0e12
palette = 1=#ff729c
palette = 15=#f8fbff
cursor-color = #adc9ea
window-padding-x = 12
window-padding-y = 12,8
`;

test("解析 Ghostty 配置：颜色、字号换算、内边距", () => {
  const t = parseGhosttyConfig(sample);
  assert.equal(t.source, "ghostty");
  assert.deepEqual(t.fontFamily, []); // 空的 font-family 表示使用 Ghostty 内置字体
  assert.equal(t.fontSizePx, 16); // 12pt × 96/72
  assert.equal(t.background, "#0c0e12");
  assert.equal(t.foreground, "#e1e6ef");
  assert.equal(t.cursor, "#adc9ea");
  assert.equal(t.cursorText, "#0c0e12"); // 未设置时取背景色
  assert.equal(t.selectionBackground, "#395571");
  assert.equal(t.palette[1], "#ff729c");
  assert.equal(t.palette[15], "#f8fbff");
  assert.equal(t.palette.length, 16);
  assert.equal(t.paddingX, 12);
  assert.equal(t.paddingY, 12);
});

test("解析 Ghostty 配置：自定义字体、未设置光标色时用前景色", () => {
  const t = parseGhosttyConfig(`font-family = "Maple Mono NF"\nfont-family = Noto Sans Mono CJK SC\nforeground = #abcdef\npalette = 99=#000000\n`);
  assert.deepEqual(t.fontFamily, ["Maple Mono NF", "Noto Sans Mono CJK SC"]);
  assert.equal(t.cursor, "#abcdef");
  assert.equal(t.palette.length, 16); // 超出 0–15 的调色板项被忽略
});
