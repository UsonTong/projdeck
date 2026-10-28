import assert from "node:assert/strict";
import { test } from "node:test";
import { isReady, planTrustKeys } from "./trust.ts";

// Claude Code v2.1.312 的真实屏幕（herdr pane.read visible）
const claudeTrust = `❯ claude --dangerously-skip-permissions

───────────────────────────────────────────────
 Accessing workspace:

 /tmp/pdtest/projA

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel`;

const claudeReady = `───────────────
❯
───────────────
  [Opus 5.5 ◑ high] │ projA
  Context ░░░░░░░░░░ 0%
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;

// Codex v0.165.0 以 --yolo 启动时的真实屏幕
const codexReady = `  >_ OpenAI Codex (v0.165.0)
     /tmp/pdtest/codextrust
  permissions: YOLO mode
› Ask Codex to do anything
  GPT-6.1-Sol high fast · /tmp/pdtest/codextrust
  ← for agents · ? for shortcuts`;

test("Claude 信任框：光标在 No 上时先下移再确认", () => {
  assert.deepEqual(planTrustKeys(claudeTrust), ["down", "enter"]);
});

test("光标已在 Yes 上时直接确认", () => {
  const screen = claudeTrust.replace(" ❯ No, exit\n   Yes, I trust", "   No, exit\n ❯ Yes, I trust");
  assert.deepEqual(planTrustKeys(screen), ["enter"]);
});

test("Yes 在第一项的编号菜单（Codex 风格）", () => {
  const screen = "Do you trust the contents of this directory?\n\n› 1. Yes, continue\n  2. No, quit\n";
  assert.deepEqual(planTrustKeys(screen), ["enter"]);
  const onNo = "Do you trust the contents of this directory?\n\n  1. Yes, continue\n› 2. No, quit\n";
  assert.deepEqual(planTrustKeys(onNo), ["up", "enter"]);
});

test("非信任框不处理", () => {
  assert.equal(planTrustKeys(claudeReady), null);
  assert.equal(planTrustKeys(codexReady), null);
  // 普通的 Yes/No 问题（不是信任框）不能被自动确认
  assert.equal(planTrustKeys("Delete all files?\n❯ No\n  Yes"), null);
});

test("识别可输入状态", () => {
  assert.ok(isReady(claudeReady));
  assert.ok(isReady(codexReady));
  assert.ok(!isReady(claudeTrust));
});
