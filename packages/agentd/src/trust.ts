import type { HerdrClient } from "./herdr/client.ts";

/** 菜单光标前缀：Claude 用 ❯，Codex 用 ›。 */
const CURSOR = /^\s*[❯›>]\s?/;
/** 信任确认框的特征文字。 */
const TRUST_PROMPT = /trust this folder|Is this a project you created or one you trust|Do you trust the (files|contents)/i;
/** 「同意」选项。 */
const YES_OPTION = /^\s*[❯›>]?\s*(\d+\.\s*)?Yes\b/;
/** agent 已进入可输入状态的标志，看到即说明没有（或已通过）信任确认。 */
const READY = /bypass permissions|\? for shortcuts|Ask Codex to do anything|Context [░▓█]/;

/**
 * 根据屏幕文字计算通过信任确认需要的按键；不是信任确认框时返回 null。
 * 不假设选项顺序（Claude 当前把「No, exit」放在第一项），而是找到光标行和 Yes 行，按差值上下移动。
 */
export function planTrustKeys(screen: string): string[] | null {
  if (!TRUST_PROMPT.test(screen)) return null;
  const lines = screen.split("\n");
  const yes = lines.findIndex((l) => YES_OPTION.test(l));
  const cursor = lines.findIndex((l) => CURSOR.test(l) && /\b(Yes|No)\b/.test(l));
  if (yes < 0 || cursor < 0) return null;
  // 选项之间可能隔着空行，按「选项序号」而不是行号计算距离
  const options = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^\s*[❯›>]?\s*(\d+\.\s*)?(Yes|No)\b/.test(l))
    .map(({ i }) => i);
  const delta = options.indexOf(yes) - options.indexOf(cursor);
  const move = delta > 0 ? Array<string>(delta).fill("down") : Array<string>(-delta).fill("up");
  return [...move, "enter"];
}

export function isReady(screen: string): boolean {
  return READY.test(screen);
}

/**
 * 在 projdeck 启动 agent 后自动通过「信任此文件夹」确认。
 * 只用于 projdeck 登记的项目目录——这些目录是用户主动新建或导入的，本身就代表信任。
 * 最多观察 timeoutMs；看到可输入状态或处理完确认框即返回。
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 按计划好的按键选中「同意」。移动光标和确认分开发送，给 TUI 留出重绘时间。 */
async function press(herdr: HerdrClient, paneId: string, keys: string[]): Promise<void> {
  if (keys.length > 1) await herdr.sendKeys(paneId, keys.slice(0, -1));
  await sleep(200);
  await herdr.sendKeys(paneId, ["enter"]);
}

export async function acceptTrustPrompt(herdr: HerdrClient, paneId: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    let screen: string;
    try {
      screen = await herdr.readVisible(paneId);
    } catch {
      return false; // pane 已关闭
    }
    if (isReady(screen)) return false;
    const keys = planTrustKeys(screen);
    if (keys) {
      await press(herdr, paneId, keys);
      return true;
    }
  }
  return false;
}

/**
 * 任何 agent 弹出「信任此文件夹」都自动同意（设置里可关闭）。
 * 典型场景：电脑重启后 herdr 用 claude --resume 恢复的会话。工作目录是主目录时 Claude 不保存信任，每次恢复都会再问。
 * herdr 把确认框识别为 blocked：状态变化时检查一次，另外每 5 秒扫一遍（agentd 刚启动、或漏掉事件时）。
 * 只处理信任确认框；权限确认、选项菜单等其他 blocked 情况不碰。
 */
export function startAutoTrust(herdr: HerdrClient, enabled: () => boolean, onAccepted?: (paneId: string) => void): () => void {
  const handled = new Map<string, number>(); // paneId → 上次处理时间，避免重绘前重复按键
  let running = false;
  const sweep = async () => {
    if (running || !enabled() || !herdr.online) return;
    running = true;
    try {
      const now = Date.now();
      for (const [pane, at] of handled) if (now - at > 60_000) handled.delete(pane);
      for (const agent of await herdr.listAgents()) {
        if (agent.agent_status !== "blocked" || now - (handled.get(agent.pane_id) ?? 0) < 10_000) continue;
        const keys = planTrustKeys(await herdr.readVisible(agent.pane_id).catch(() => ""));
        if (!keys) continue;
        handled.set(agent.pane_id, now);
        await press(herdr, agent.pane_id, keys);
        onAccepted?.(agent.pane_id);
      }
    } catch {
      // herdr 断开等，下一轮再试
    } finally {
      running = false;
    }
  };
  let debounce: NodeJS.Timeout | undefined;
  const onEvent = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => void sweep(), 300);
  };
  herdr.on("event", onEvent);
  const timer = setInterval(() => void sweep(), 5_000);
  void sweep();
  return () => {
    herdr.off("event", onEvent);
    clearInterval(timer);
    clearTimeout(debounce);
  };
}
