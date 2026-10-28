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
export async function acceptTrustPrompt(herdr: HerdrClient, paneId: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    let screen: string;
    try {
      screen = await herdr.readVisible(paneId);
    } catch {
      return false; // pane 已关闭
    }
    if (isReady(screen)) return false;
    const keys = planTrustKeys(screen);
    if (keys) {
      // 移动光标和确认分开发送，给 TUI 留出重绘时间
      if (keys.length > 1) await herdr.sendKeys(paneId, keys.slice(0, -1));
      await new Promise((r) => setTimeout(r, 200));
      await herdr.sendKeys(paneId, ["enter"]);
      return true;
    }
  }
  return false;
}
