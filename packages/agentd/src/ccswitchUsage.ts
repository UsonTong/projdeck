import { DatabaseSync } from "node:sqlite";
import type { CcUsage, CcUsageRange, CcUsageRow } from "@projdeck/shared";

/*
 * CC Switch 的用量统计（只读）：它把 Claude Code / Codex 等的每次请求记在 proxy_request_logs 里
 * （经它的本地代理的请求，以及从会话日志导入的），这里按它的口径汇总，与它的「用量」页一致：
 * - Tokens = 新增输入 + 输出 + 缓存写入 + 缓存命中。Codex / Gemini / Grok 记的输入已包含缓存，先减掉；
 * - 缓存命中率 = 缓存命中 / (新增输入 + 缓存写入 + 缓存命中)；
 * - 速度：经代理的请求按（耗时 − 首字）精确计算；会话日志导入的只能估算（含首字等待），首字同理，界面上标「≈」。
 * 规则来自 CC Switch 4.0.19 的 services/sql_helpers.rs、services/usage_stats.rs。
 */

const CACHE_INCLUSIVE = "('codex', 'gemini', 'grokbuild')";
const FRESH_INPUT = `CASE
  WHEN input_token_semantics = 2 THEN input_tokens
  WHEN app_type IN ${CACHE_INCLUSIVE} AND input_token_semantics = 1 AND input_tokens >= cache_read_tokens + cache_creation_tokens
    THEN input_tokens - cache_read_tokens - cache_creation_tokens
  WHEN app_type IN ${CACHE_INCLUSIVE} AND input_token_semantics = 0 AND input_tokens >= cache_read_tokens
    THEN input_tokens - cache_read_tokens
  ELSE input_tokens END`;
const TOKENS = `((${FRESH_INPUT}) + output_tokens + cache_creation_tokens + cache_read_tokens)`;
const COST = "CAST(total_cost_usd AS REAL)";
const OK = "(status_code >= 200 AND status_code < 300)";
const PROXY = "COALESCE(data_source, 'proxy') = 'proxy'";
// 速度：精确（经代理）与估算（会话日志）分开累加，有精确数据时用精确的
const SPEED_EXACT = `${PROXY} AND first_token_ms IS NOT NULL AND output_tokens >= 100 AND latency_ms - first_token_ms >= 100`;
const SPEED_EST = `NOT (${PROXY}) AND output_tokens >= 200 AND latency_ms >= 1000`;

const APP_LABELS: Record<string, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini CLI",
  grokbuild: "Grok Build",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  pi: "Pi",
  mcode: "MiniMax Code",
  kimi: "Kimi Code",
  agy: "Antigravity",
};

/** 会话日志导入的记录没有具体供应商，用这些占位 id。 */
const SESSION_PROVIDERS: Record<string, string> = { _session: "会话日志 · Claude Code", _codex_session: "会话日志 · Codex" };

const localMidnight = (daysAgo: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return Math.floor(d.getTime() / 1000);
};

const pad = (n: number) => String(n).padStart(2, "0");

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function readUsage(dbFile: string, range: CcUsageRange, app: string | null): CcUsage {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const since = range === "today" ? localMidnight(0) : range === "7d" ? localMidnight(6) : range === "30d" ? localMidnight(29) : 0;
    const where = `created_at >= ? ${app ? "AND app_type = ?" : ""}`;
    const params = app ? [since, app] : [since];

    const apps = (db.prepare("SELECT app_type, COUNT(*) n FROM proxy_request_logs GROUP BY app_type ORDER BY n DESC").all() as { app_type: string }[]).map((r) => ({
      app: r.app_type,
      label: APP_LABELS[r.app_type] ?? r.app_type,
    }));

    const sum = db
      .prepare(
        `SELECT COUNT(*) requests, COALESCE(SUM(${COST}), 0) cost, COALESCE(SUM(${TOKENS}), 0) tokens,
                COALESCE(SUM(${FRESH_INPUT}), 0) fresh, COALESCE(SUM(cache_read_tokens), 0) cr, COALESCE(SUM(cache_creation_tokens), 0) cc
         FROM proxy_request_logs WHERE ${where}`,
      )
      .get(...params) as { requests: number; cost: number; tokens: number; fresh: number; cr: number; cc: number };
    const today = db
      .prepare(`SELECT COALESCE(SUM(${COST}), 0) cost FROM proxy_request_logs WHERE created_at >= ?`)
      .get(localMidnight(0)) as { cost: number };

    // 趋势：今天按小时，其他按天（没有记录的天补 0）
    const hourly = range === "today";
    const bucketSql = hourly ? "strftime('%H', created_at, 'unixepoch', 'localtime')" : "date(created_at, 'unixepoch', 'localtime')";
    const buckets = new Map(
      (
        db
          .prepare(
            `SELECT ${bucketSql} b, COUNT(*) requests, COALESCE(SUM(${COST}), 0) cost, COALESCE(SUM(${TOKENS}), 0) tokens
             FROM proxy_request_logs WHERE ${where} GROUP BY b ORDER BY b`,
          )
          .all(...params) as { b: string; requests: number; cost: number; tokens: number }[]
      ).map((r) => [r.b, r]),
    );
    const series: CcUsage["series"] = [];
    if (hourly) {
      for (let h = 0; h <= new Date().getHours(); h++) {
        const r = buckets.get(pad(h));
        series.push({ label: `${pad(h)}:00`, requests: r?.requests ?? 0, cost: r?.cost ?? 0, tokens: r?.tokens ?? 0 });
      }
    } else {
      const first = range === "all" ? [...buckets.keys()][0] : null;
      const start = first ? new Date(`${first}T00:00:00`) : new Date(since * 1000);
      for (const d = start; d.getTime() <= Date.now(); d.setDate(d.getDate() + 1)) {
        const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const r = buckets.get(key);
        series.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, requests: r?.requests ?? 0, cost: r?.cost ?? 0, tokens: r?.tokens ?? 0 });
      }
    }

    const names = new Map(
      (db.prepare("SELECT id, app_type, name FROM providers").all() as { id: string; app_type: string; name: string }[]).map((p) => [`${p.app_type}|${p.id}`, p.name]),
    );
    const group = (key: string): CcUsageRow[] => {
      const rows = db
        .prepare(
          `SELECT ${key} k, app_type, COUNT(*) requests, COALESCE(SUM(${COST}), 0) cost, COALESCE(SUM(${TOKENS}), 0) tokens,
                  SUM(${OK}) ok,
                  SUM(CASE WHEN ${SPEED_EXACT} THEN output_tokens END) exact_out, SUM(CASE WHEN ${SPEED_EXACT} THEN latency_ms - first_token_ms END) exact_ms,
                  SUM(CASE WHEN ${SPEED_EST} THEN output_tokens END) est_out, SUM(CASE WHEN ${SPEED_EST} THEN latency_ms END) est_ms
           FROM proxy_request_logs WHERE ${where} GROUP BY k, app_type ORDER BY requests DESC`,
        )
        .all(...params) as {
        k: string;
        app_type: string;
        requests: number;
        cost: number;
        tokens: number;
        ok: number;
        exact_out: number | null;
        exact_ms: number | null;
        est_out: number | null;
        est_ms: number | null;
      }[];
      // 首字中位数：精确与估算分开取
      const firstTokens = db
        .prepare(`SELECT ${key} k, app_type, first_token_ms ms, ${PROXY} exact FROM proxy_request_logs WHERE ${where} AND first_token_ms IS NOT NULL AND ${OK}`)
        .all(...params) as { k: string; app_type: string; ms: number; exact: number }[];
      return rows.map((r) => {
        const ft = firstTokens.filter((f) => f.k === r.k && f.app_type === r.app_type);
        const exactFt = median(ft.filter((f) => f.exact).map((f) => f.ms));
        const exact = !!r.exact_ms;
        const name = key === "model" ? r.k : (SESSION_PROVIDERS[r.k] ?? names.get(`${r.app_type}|${r.k}`) ?? r.k);
        return {
          name,
          app: r.app_type,
          requests: r.requests,
          cost: r.cost,
          tokens: r.tokens,
          successRate: r.requests ? r.ok / r.requests : 0,
          speed: exact ? (r.exact_out! / r.exact_ms!) * 1000 : r.est_ms ? (r.est_out! / r.est_ms) * 1000 : null,
          speedEstimated: !exact,
          firstTokenMs: exactFt ?? median(ft.map((f) => f.ms)),
          firstTokenEstimated: exactFt === null,
        };
      });
    };

    const logs = (
      db
        .prepare(
          `SELECT created_at, app_type, provider_id, model, ${FRESH_INPUT} fresh, output_tokens, cache_read_tokens, cache_creation_tokens, ${COST} cost,
                  status_code, latency_ms FROM proxy_request_logs WHERE ${where} ORDER BY created_at DESC LIMIT 100`,
        )
        .all(...params) as {
        created_at: number;
        app_type: string;
        provider_id: string;
        model: string;
        fresh: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        cost: number;
        status_code: number;
        latency_ms: number;
      }[]
    ).map((r) => ({
      at: r.created_at * 1000,
      app: r.app_type,
      provider: SESSION_PROVIDERS[r.provider_id] ?? names.get(`${r.app_type}|${r.provider_id}`) ?? r.provider_id,
      model: r.model,
      input: r.fresh,
      output: r.output_tokens,
      cacheRead: r.cache_read_tokens,
      cacheCreation: r.cache_creation_tokens,
      cost: r.cost,
      status: r.status_code,
      latencyMs: r.latency_ms,
    }));

    const cacheable = sum.fresh + sum.cc + sum.cr;
    return {
      range,
      app,
      apps,
      summary: { cost: sum.cost, requests: sum.requests, tokens: sum.tokens, cacheHitRate: cacheable ? sum.cr / cacheable : 0, todayCost: today.cost },
      series,
      models: group("model"),
      providers: group("provider_id"),
      logs,
    };
  } finally {
    db.close();
  }
}
