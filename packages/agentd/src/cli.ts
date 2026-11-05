#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { hashPassword, SessionStore } from "./auth.ts";
import { configDir, loadConfig, saveConfig } from "./config.ts";

const usage = `用法：
  set-password     设置登录密码（交互输入，不回显）
  revoke-sessions  注销所有已登录的设备
  show-config      显示当前配置（不含密码哈希）
  present <路径>   主动在 projdeck 网页/手机上展示一张图片（项目、上传或临时目录；可加 --title）`;

async function readHidden(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // 屏蔽回显：readline 写回输入字符时什么都不输出
  const rlOut = rl as unknown as { _writeToOutput: (s: string) => void };
  let prompted = false;
  rlOut._writeToOutput = (s: string) => {
    if (!prompted) {
      stdout.write(s);
      prompted = true;
    }
  };
  const answer = await rl.question(prompt);
  rl.close();
  stdout.write("\n");
  return answer;
}

const [command] = process.argv.slice(2);

switch (command) {
  case "set-password": {
    const pw = await readHidden("新密码（至少 12 位）：");
    if (pw.length < 12) {
      console.error("密码太短。projdeck 能远程执行任意命令，请使用强密码。");
      process.exit(1);
    }
    const again = await readHidden("再输入一次：");
    if (pw !== again) {
      console.error("两次输入不一致。");
      process.exit(1);
    }
    saveConfig({ passwordHash: await hashPassword(pw) });
    new SessionStore().revokeAll();
    console.log(`密码已保存到 ${configDir}/config.json，所有旧登录已注销。重启 agentd 后生效。`);
    break;
  }
  case "revoke-sessions":
    new SessionStore().revokeAll();
    console.log("已注销所有设备。");
    break;
  case "present": {
    const target = process.argv[3];
    if (!target) {
      console.error(usage);
      process.exit(1);
    }
    const titleIndex = process.argv.indexOf("--title");
    const title = titleIndex > 0 ? process.argv[titleIndex + 1] : undefined;
    const config = loadConfig();
    let key: string;
    try {
      key = readFileSync(config.accessKeyFile, "utf8").trim();
    } catch {
      console.error("找不到访问密钥：请先配置 projdeck 公网访问 key");
      process.exit(1);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${config.port}/api/present`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `projdeck_key=${key}` },
        body: JSON.stringify({ path: target, title }),
      });
      const data = await res.json() as { title?: string; url?: string; error?: string };
      if (!res.ok) {
        console.error(data.error ?? `展示失败（HTTP ${res.status}）`);
        process.exit(1);
      }
      console.log(`已展示「${data.title}」：${data.url}`);
    } catch (err) {
      console.error(`连不上本机 projdeck：${(err as Error).message}`);
      process.exit(1);
    }
    break;
  }
  case "show-config": {
    const { passwordHash, ...rest } = loadConfig();
    console.log(JSON.stringify({ ...rest, passwordSet: passwordHash !== null }, null, 2));
    break;
  }
  default:
    console.log(usage);
}
