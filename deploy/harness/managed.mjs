#!/usr/bin/env node
// systemd 托管 dsh web：启动链接只在内存处理，不进入 journal；自动更新 projdeck 的连接。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const loopback = (url) => url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password;
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
export const redact = (text) => stripAnsi(text).replace(/([?&]token=)[^\s&"'<>]+/gi, '$1[redacted]');

export function startupUrl(line, port) {
  if (!/^\s*dsh web:\s*/i.test(stripAnsi(line))) return null;
  for (const candidate of stripAnsi(line).match(/http:\/\/[^\s"'<>]+/g) ?? []) {
    try {
      const url = new URL(candidate);
      if (loopback(url) && Number(url.port || 80) === port && url.pathname === '/' && url.searchParams.getAll('token').length === 1 && url.searchParams.get('token')) return url;
    } catch { /* 不把无效 URL 或凭据打印出来 */ }
  }
  return null;
}

export async function saveConnection(file, url) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const base = new URL(url);
  const token = base.searchParams.get('token');
  base.search = ''; base.hash = '';
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ base: base.href, token }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}

export async function run(env = process.env) {
  const port = Number(env.PROJDECK_HARNESS_PORT || '3081');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('无效的 Harness 本机端口');
  const api = new URL(env.PROJDECK_AGENTD_URL || 'http://127.0.0.1:7420/');
  if (!loopback(api) || api.pathname !== '/' || api.search || api.hash) throw new Error('projdeck 管理接口必须是本机 HTTP 根地址');
  const configDir = env.PROJDECK_CONFIG_DIR || join(homedir(), '.config', 'projdeck');
  const keyFile = env.PROJDECK_ACCESS_KEY_FILE || join(configDir, 'edge-key');
  let ready;
  let dirty = false;
  let syncing = false;
  let stopping = false;
  let lastNotice = '';
  const log = (text) => console.log(redact(text));
  const notice = (text) => { if (lastNotice !== text) { lastNotice = text; log(text); } };
  const sync = async () => {
    if (!ready || syncing || stopping) return;
    syncing = true;
    try {
      const key = (await readFile(keyFile, 'utf8')).trim();
      if (key.length < 16 || /[\r\n;]/.test(key)) throw new Error();
      const headers = { cookie: `projdeck_key=${key}`, 'content-type': 'application/json' };
      if (!dirty) {
        const r = await fetch(new URL('api/harness', api), { headers, signal: AbortSignal.timeout(8_000), redirect: 'error' });
        const state = r.ok ? await r.json() : null;
        if (state?.configured && state.online) return;
      }
      const r = await fetch(new URL('api/harness', api), {
        method: 'PUT', headers, body: JSON.stringify({ connectionUrl: ready.href }),
        signal: AbortSignal.timeout(12_000), redirect: 'error',
      });
      const state = r.ok ? await r.json() : null;
      if (!state?.configured || !state.online) throw new Error();
      dirty = false;
      notice('Harness 已自动接入 projdeck');
    } catch {
      // 不输出 fetch 异常：某些异常会包含带 token 的地址或请求参数。
      notice('等待 projdeck 就绪，连接配置已保存；稍后自动重试');
    } finally { syncing = false; }
  };

  const child = spawn(env.PROJDECK_DSH_BIN || '/usr/local/bin/dsh', ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: env.PROJDECK_HARNESS_WORKDIR || homedir(), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const readers = [createInterface({ input: child.stdout }), createInterface({ input: child.stderr })];
  const publish = async (url) => {
    try {
      await saveConnection(join(configDir, 'harness.json'), url);
      ready = url; dirty = true;
      notice(`Harness 已就绪，本机端口 ${port}；正在更新 projdeck 连接`);
      await sync();
    } catch {
      notice('无法保存 Harness 连接配置，请检查配置目录权限及磁盘空间');
      child.kill('SIGTERM');
    }
  };
  for (const reader of readers) reader.on('line', (line) => {
    const url = startupUrl(line, port);
    if (url) { void publish(url); return; }
    log(line);
  });
  const interval = setInterval(() => void sync(), Number(env.PROJDECK_HARNESS_SYNC_MS || 15_000));
  const stop = () => { stopping = true; clearInterval(interval); child.kill('SIGTERM'); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const code = await new Promise((resolve) => {
    child.once('error', () => { notice('无法启动 dsh，请检查 Harness 安装路径'); resolve(1); });
    child.once('exit', (code, signal) => resolve(stopping ? 0 : code ?? (signal ? 1 : 0)));
  });
  clearInterval(interval);
  for (const reader of readers) reader.close();
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = await run(); }
  catch { console.error('Harness 托管配置无效，未启动服务'); process.exitCode = 1; }
}
