import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * 电脑上是否开着 herdr 桌面客户端（连着 agentd 使用的这个 herdr 会话）。
 * herdr 的 API 不提供客户端列表；agentd 与 herdr 在同一台电脑上，直接看进程。
 * 客户端的启动方式：`herdr`（默认会话）、`herdr --session <名字>`、`herdr session attach <名字>`。
 */
export async function desktopClientConnected(herdrSocket: string): Promise<boolean> {
  const session = /\/sessions\/([^/]+)\/herdr\.sock$/.exec(herdrSocket)?.[1] ?? "default";
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((d) => /^\d+$/.test(d));
  } catch {
    return false;
  }
  for (const pid of pids) {
    let argv: string[];
    try {
      argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    } catch {
      continue; // 进程已退出
    }
    if (!argv[0] || basename(argv[0]) !== "herdr") continue;
    const args = argv.slice(1);
    const target =
      args.length === 0
        ? "default"
        : args[0] === "--session" && args.length === 2
          ? args[1]
          : args[0]?.startsWith("--session=") && args.length === 1
            ? args[0].slice("--session=".length)
            : args[0] === "session" && args[1] === "attach" && args.length === 3
              ? args[2]
              : null;
    if (target === session) return true;
  }
  return false;
}
