import assert from "node:assert/strict";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { AdbRelay, CLOSE, DATA, OPEN, type PhoneLink } from "./adbRelay.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 假的手机：收到 OPEN 就去连 echoPort，把收到的数据按帧格式回给转发器。 */
function fakePhone(echoPort: number, relayRef: { receive?: (b: Buffer) => void }) {
  const sockets = new Map<number, Socket>();
  const link: PhoneLink = {
    send: (f) => {
      const type = f[0];
      const id = f.readUInt32BE(1);
      if (type === OPEN) {
        const s = createConnection(echoPort, "127.0.0.1");
        sockets.set(id, s);
        s.on("data", (d: Buffer) => {
          const head = Buffer.alloc(5);
          head[0] = DATA;
          head.writeUInt32BE(id, 1);
          relayRef.receive?.(Buffer.concat([head, d]));
        });
        s.on("close", () => {
          const head = Buffer.alloc(5);
          head[0] = CLOSE;
          head.writeUInt32BE(id, 1);
          relayRef.receive?.(head);
        });
      } else if (type === DATA) sockets.get(id)?.write(f.subarray(5));
      else if (type === CLOSE) sockets.get(id)?.destroy();
    },
    bufferedAmount: () => 0,
    close: () => sockets.forEach((s) => s.destroy()),
  };
  return link;
}

function echoServer(): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer((c) => c.pipe(c));
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

const connect = (port: number) =>
  new Promise<Socket>((resolve, reject) => {
    const s = createConnection(port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });

const readN = (s: Socket, n: number) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    let len = 0;
    s.on("data", (d: Buffer) => {
      chunks.push(d);
      len += d.length;
      if (len >= n) resolve(Buffer.concat(chunks));
    });
  });

test("手机连上后才监听；数据经手机来回，大数据也完整", async () => {
  const echo = await echoServer();
  const relay = new AdbRelay(0);
  assert.equal(relay.status().connected, false);
  assert.equal(relay.status().port, null);

  const ref: { receive?: (b: Buffer) => void } = {};
  const att = relay.attach(fakePhone((echo.address() as { port: number }).port, ref));
  ref.receive = att.receive;
  await sleep(50);
  const st = relay.status();
  assert.equal(st.connected, true);
  assert.ok(st.port && st.port > 0);

  const c = await connect(st.port!);
  c.write("hello");
  assert.equal((await readN(c, 5)).toString(), "hello");

  // 200KB：要拆成多个帧，且顺序、内容都不能错
  const big = Buffer.alloc(200 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const c2 = await connect(st.port!);
  const got = readN(c2, big.length);
  c2.write(big);
  assert.ok((await got).equals(big));
  assert.equal(relay.status().connections, 2);

  c.destroy();
  c2.destroy();
  await sleep(100);
  assert.equal(relay.status().connections, 0);

  att.detach();
  assert.equal(relay.status().connected, false);
  await assert.rejects(connect(st.port!)); // 手机断开后端口不再监听
  echo.close();
});

test("后连的手机顶掉先连的；断开后不能再收旧手机的帧", async () => {
  const echo = await echoServer();
  const relay = new AdbRelay(0);
  const port = (echo.address() as { port: number }).port;
  const ref1: { receive?: (b: Buffer) => void } = {};
  let closed1 = false;
  const phone1 = fakePhone(port, ref1);
  const att1 = relay.attach({ ...phone1, close: () => ((closed1 = true), phone1.close()) });
  ref1.receive = att1.receive;
  const ref2: { receive?: (b: Buffer) => void } = {};
  const att2 = relay.attach(fakePhone(port, ref2));
  ref2.receive = att2.receive;
  assert.equal(closed1, true);
  await sleep(50);
  att1.detach(); // 旧手机的断开事件不能影响新手机
  assert.equal(relay.status().connected, true);
  const c = await connect(relay.status().port!);
  c.write("x");
  assert.equal((await readN(c, 1)).toString(), "x");
  c.destroy();
  relay.stop();
  echo.close();
});
