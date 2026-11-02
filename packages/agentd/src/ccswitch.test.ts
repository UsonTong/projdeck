import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CcSwitch, projectClaudeSettings } from "./ccswitch.ts";

const official = { env: {} };
const deepseek = {
  env: {
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: "sk-ds",
    ANTHROPIC_MODEL: "deepseek-v4",
    CLAUDE_CODE_DISABLE_ARTIFACT: "1",
    DISABLE_TELEMETRY: "1", // 不是供应商的键，不投影
  },
  hooks: { Stop: [] }, // 旧版回填进来的，不投影
};
const relay = { env: { ANTHROPIC_BASE_URL: "https://relay.example", ANTHROPIC_AUTH_TOKEN: "sk-relay", CLAUDE_CODE_AUTO_MODE_SERVER: "0" } };

test("关键字段换成目标的，用户自己的键原样保留", () => {
  const live = {
    env: { ANTHROPIC_BASE_URL: "https://relay.example", ANTHROPIC_AUTH_TOKEN: "sk-relay", CLAUDE_CODE_AUTO_MODE_SERVER: "0", MY_VAR: "x" },
    model: "opus",
    hooks: { Notification: [] },
    permissions: { allow: ["Bash"] },
  };
  const out = projectClaudeSettings(live, relay, deepseek);
  assert.deepEqual(out, {
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "sk-ds",
      MY_VAR: "x",
      ANTHROPIC_MODEL: "deepseek-v4",
      CLAUDE_CODE_DISABLE_ARTIFACT: "1",
    },
    hooks: { Notification: [] },
    permissions: { allow: ["Bash"] },
  });
  // 键的顺序：原有的键原位覆盖
  assert.deepEqual(Object.keys(out.env as object).slice(0, 2), ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]);
});

test("切到官方：清空所有关键字段；上一家的独有字段只在没改过时删除", () => {
  const live = { env: { ANTHROPIC_BASE_URL: "x", ANTHROPIC_AUTH_TOKEN: "y", CLAUDE_CODE_DISABLE_ARTIFACT: "1", CLAUDE_CODE_AUTO_MODE_SERVER: "1" } };
  const prev = { env: { ANTHROPIC_BASE_URL: "x", CLAUDE_CODE_DISABLE_ARTIFACT: "1", CLAUDE_CODE_AUTO_MODE_SERVER: "0" } };
  // AUTO_MODE_SERVER 被用户改成了 1，保留
  assert.deepEqual(projectClaudeSettings(live, prev, official), { env: { CLAUDE_CODE_AUTO_MODE_SERVER: "1" } });
});

test("旧版残留的窗口值删除，目标自己要写的除外", () => {
  const live = { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: 131072, CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "5" } };
  const target = { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144" } };
  assert.deepEqual(projectClaudeSettings(live, null, target), {
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "5" },
  });
});

/** 一个假的 CC Switch 数据目录（没有在运行的 GUI）。 */
function sandbox(live: object | null) {
  const dir = mkdtempSync(join(tmpdir(), "pd-ccs-"));
  const db = new DatabaseSync(join(dir, "cc-switch.db"));
  db.exec(`CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL,
    website_url TEXT, category TEXT, created_at INTEGER, sort_index INTEGER, is_current BOOLEAN NOT NULL DEFAULT 0, PRIMARY KEY (id, app_type))`);
  const add = db.prepare("INSERT INTO providers (id, app_type, name, settings_config, created_at, sort_index, is_current) VALUES (?, ?, ?, ?, ?, ?, ?)");
  add.run("claude-official", "claude", "Claude Official", JSON.stringify(official), 1, 0, 0);
  add.run("ds", "claude", "DeepSeek", JSON.stringify(deepseek), 2, null, 0);
  add.run("relay", "claude", "Relay", JSON.stringify(relay), 3, null, 1);
  add.run("codex-official", "codex", "OpenAI Official", "{}", 1, 0, 1);
  db.close();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ currentProviderClaude: "relay", currentProviderCodex: "codex-official", language: "zh" }, null, 2) + "\n");
  writeFileSync(join(dir, "live-state.json"), JSON.stringify({ version: 1, apps: { claude: { mode: "direct" } } }));
  const claudeSettings = join(dir, "claude-settings.json");
  if (live) writeFileSync(claudeSettings, JSON.stringify(live, null, 2) + "\n");
  const ccs = new CcSwitch({ dir, claudeSettings, bin: join(dir, "no-such-binary"), backupDir: join(dir, "backups") });
  return { dir, claudeSettings, ccs };
}

test("按应用列出供应商（不含配置和密钥），按 CC Switch 的顺序；没有托盘时当前供应商取它设置里的指针", async () => {
  const { ccs } = sandbox(null);
  const s = await ccs.status();
  assert.equal(s.running, false);
  assert.deepEqual(
    s.apps.map((a) => a.label),
    ["Claude Code", "Codex", "Pi"], // Pi 没有供应商时也列出来（空的）
  );
  assert.deepEqual(s.apps[2]!.providers, []);
  const claude = s.apps[0]!;
  assert.deepEqual(
    claude.providers.map((p) => `${p.name}${p.current ? "*" : ""}`),
    ["Claude Official", "DeepSeek", "Relay*"],
  );
  assert.ok(!JSON.stringify(s).includes("sk-"));
});

test("切换：改 Claude 配置、数据库的 is_current、CC Switch 设置里的指针，其余不动", async () => {
  const { dir, claudeSettings, ccs } = sandbox({ env: { ...relay.env, MY_VAR: "x" }, permissions: { allow: [] } });
  assert.deepEqual(await ccs.switchProvider("claude", "ds"), { via: "files", launched: false });
  const live = JSON.parse(readFileSync(claudeSettings, "utf8"));
  assert.equal(live.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(live.env.MY_VAR, "x");
  assert.equal(live.env.CLAUDE_CODE_AUTO_MODE_SERVER, undefined);
  assert.deepEqual(live.permissions, { allow: [] });
  assert.equal(statSync(claudeSettings).mode & 0o777, 0o600);
  assert.equal(readdirSync(join(dir, "backups")).length, 1);

  const db = new DatabaseSync(join(dir, "cc-switch.db"), { readOnly: true });
  const current = db.prepare("SELECT id, app_type FROM providers WHERE is_current = 1 ORDER BY app_type").all();
  db.close();
  assert.deepEqual(current.map((r) => `${r.app_type}:${r.id}`), ["claude:ds", "codex:codex-official"]);

  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.deepEqual(settings, { currentProviderClaude: "ds", currentProviderCodex: "codex-official", language: "zh" });
  assert.equal((await ccs.status()).apps[0]!.providers.find((p) => p.current)?.id, "ds");
});

test("没有托盘时：CC Switch 用代理接管或有没做完的操作时拒绝改文件；其他应用不支持", async () => {
  const { dir, ccs } = sandbox({});
  writeFileSync(join(dir, "live-state.json"), JSON.stringify({ apps: { claude: { mode: "proxy" } } }));
  await assert.rejects(ccs.switchProvider("claude", "ds"), /代理/);
  writeFileSync(join(dir, "live-state.json"), JSON.stringify({ apps: { codex: { mode: "direct", pending: { target: "x" } } } }));
  await assert.rejects(ccs.switchProvider("claude", "ds"), /没做完/);
  await assert.rejects(ccs.switchProvider("codex", "codex-official"), /托盘/);
});
