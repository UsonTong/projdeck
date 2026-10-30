import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/*
 * 通过 CC Switch 的托盘菜单切换供应商。
 *
 * Linux 上托盘菜单经 D-Bus（com.canonical.dbusmenu）导出：每个应用一个子菜单，标题是「应用 · 当前供应商」，
 * 里面每个供应商是一个勾选项（toggle-state = 1 表示当前）。向勾选项发送 clicked 事件，等同于在托盘里点它：
 * 由 CC Switch 自己完成切换，写哪些文件、怎么处理登录和代理模式都与在它界面里操作完全一致，界面也立即同步。
 */

const ITEM_PATH = "/org/ayatana/NotificationItem/tray_icon_tray_app_cc_switch";
const MENU_PATH = `${ITEM_PATH}/Menu`;

export interface TraySection {
  /** 子菜单标题，例如「Claude Code · DeepSeek」。 */
  label: string;
  items: { id: number; label: string; checked: boolean }[];
}

type Variant = { type: string; data: unknown };
type Node = { type: string; data: [number, Record<string, Variant>, Node[]] };

const busctl = async (...args: string[]) => (await run("busctl", ["--user", "--json=short", ...args], { timeout: 5_000 })).stdout;

/** CC Switch 进程在会话总线上的连接名（托盘菜单在其中一个连接上）。 */
async function connectionsOf(pids: number[]): Promise<string[]> {
  const list = JSON.parse(await busctl("list")) as { name: string; pid?: number }[];
  return list.filter((n) => n.name.startsWith(":") && n.pid !== undefined && pids.includes(n.pid)).map((n) => n.name);
}

async function layout(dest: string): Promise<TraySection[]> {
  const out = JSON.parse(await busctl("call", dest, MENU_PATH, "com.canonical.dbusmenu", "GetLayout", "--", "iias", "0", "-1", "0")) as {
    data: [number, Node["data"]];
  };
  const [, root] = out.data;
  const sections: TraySection[] = [];
  for (const child of root[2]) {
    const [, props, kids] = child.data;
    if (props["children-display"]?.data !== "submenu") continue;
    sections.push({
      label: String(props.label?.data ?? ""),
      items: kids
        .map((k) => k.data)
        .filter(([, p]) => p["toggle-type"]?.data === "checkmark" || p["toggle-type"]?.data === "radio")
        .map(([id, p]) => ({ id, label: String(p.label?.data ?? ""), checked: p["toggle-state"]?.data === 1 })),
    });
  }
  return sections;
}

export class CcSwitchTray {
  private readonly dest: string;

  private constructor(dest: string) {
    this.dest = dest;
  }

  /** 找到正在运行的 CC Switch 的托盘菜单；没有托盘（未运行、或设置里关了托盘）时为 null。 */
  static async find(pids: number[]): Promise<CcSwitchTray | null> {
    if (pids.length === 0) return null;
    try {
      for (const name of await connectionsOf(pids)) {
        try {
          await layout(name);
          return new CcSwitchTray(name);
        } catch {
          // 这个连接上没有托盘菜单
        }
      }
    } catch {
      // 没有 busctl 或会话总线
    }
    return null;
  }

  sections(): Promise<TraySection[]> {
    return layout(this.dest);
  }

  async click(id: number): Promise<void> {
    await busctl("call", this.dest, MENU_PATH, "com.canonical.dbusmenu", "Event", "--", "isvu", String(id), "clicked", "i", "0", "0");
  }
}
