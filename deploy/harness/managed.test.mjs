import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { redact, saveConnection, startupUrl } from './managed.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const script = fileURLToPath(new URL('./managed.mjs', import.meta.url));
const token = 'fake-startup-token-for-test';

test('只接受 dsh 就绪行中的正确本机地址，日志不打印 token', () => {
  const line = `\x1b[32mdsh web: http://127.0.0.1:3081/?token=${token}\x1b[0m`;
  assert.equal(startupUrl(line, 3081)?.searchParams.get('token'), token);
  assert.equal(startupUrl(`other output: http://127.0.0.1:3081/?token=${token}`, 3081), null);
  assert.equal(startupUrl(`dsh web: http://evil.invalid:3081/?token=${token}`, 3081), null);
  assert.equal(startupUrl(`dsh web: http://127.0.0.1:3080/?token=${token}`, 3081), null);
  assert.ok(!redact(line).includes(token));
});

test('自动连接文件原子保存为 0600，重启的新 token 覆盖旧 token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-managed-config-'));
  try {
    const file = join(dir, 'config', 'harness.json');
    await saveConnection(file, new URL(`http://127.0.0.1:3081/?token=${token}`));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { base: 'http://127.0.0.1:3081/', token });
    await saveConnection(file, new URL('http://127.0.0.1:3081/?token=new-token'));
    assert.equal(JSON.parse(await readFile(file, 'utf8')).token, 'new-token');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('真实启动托管器：管理接口暂未就绪会重试，重启后自动更新连接，日志无凭据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-managed-process-'));
  const calls = [];
  let rejectFirst = true;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', b => body += b);
    req.on('end', () => {
      assert.equal(req.headers.cookie, 'projdeck_key=fake-projdeck-key-for-test');
      if (req.method === 'PUT') {
        calls.push(JSON.parse(body).connectionUrl);
        if (rejectFirst) { rejectFirst = false; res.writeHead(503).end('{}'); return; }
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ configured: true, online: true }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  let child;
  let output = '';
  try {
    await mkdir(join(dir, 'config'));
    await writeFile(join(dir, 'config', 'edge-key'), 'fake-projdeck-key-for-test', { mode: 0o600 });
    const cli = join(dir, 'fake-dsh');
    await writeFile(cli, `#!/usr/bin/env node\nconsole.log('dsh web: http://127.0.0.1:3081/?token='+process.env.FAKE_TOKEN); setInterval(()=>{},1000);\n`, { mode: 0o700 });
    const start = (value) => {
      child = spawn(process.execPath, [script], { env: { ...process.env, PROJDECK_DSH_BIN: cli,
        PROJDECK_CONFIG_DIR: join(dir, 'config'), PROJDECK_AGENTD_URL: `http://127.0.0.1:${address.port}/`,
        PROJDECK_HARNESS_SYNC_MS: '80', FAKE_TOKEN: value }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    };
    const until = async (predicate) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) { if (Date.now() > deadline) throw Error('等待托管器超时'); await sleep(30); }
    };
    start(token);
    await until(() => calls.length >= 2 && output.includes('已自动接入'));
    assert.equal(JSON.parse(await readFile(join(dir, 'config', 'harness.json'), 'utf8')).token, token);
    await new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); });
    start('second-boot-token');
    await until(() => calls.some(url => url.includes('second-boot-token')));
    assert.equal(JSON.parse(await readFile(join(dir, 'config', 'harness.json'), 'utf8')).token, 'second-boot-token');
    assert.ok(!output.includes(token));
    assert.ok(!output.includes('second-boot-token'));
    assert.ok(!output.includes('fake-projdeck-key-for-test'));
  } finally {
    if (child?.exitCode === null) await new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); });
    await new Promise(r => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
