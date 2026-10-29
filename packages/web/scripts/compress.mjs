// 构建后为 JS / CSS / WASM / SVG 生成 .br 与 .gz，agentd 直接发送压缩版本（@fastify/static 的 preCompressed）。
// 在本机压缩，经过 SSH 隧道和公网传输的数据量约为原来的三分之一。
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = new URL("../dist/", import.meta.url).pathname;
const exts = /\.(js|css|html|svg|wasm|json|webmanifest)$/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (exts.test(name)) yield path;
  }
}

for (const path of files(dist)) {
  const data = readFileSync(path);
  if (data.length < 1024) continue;
  writeFileSync(`${path}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }));
}
