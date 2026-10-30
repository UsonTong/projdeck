import { api } from "../api.ts";

/**
 * 这台设备的推送通知（完成 / 需处理提醒）。
 * iPhone / iPad 只有「添加到主屏幕」后打开的 projdeck 才能收推送（iOS 16.4+），在 Safari 标签页里不行。
 */
export type PushState = "unsupported" | "needs-install" | "denied" | "on" | "off";

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

async function subscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIos() && !standalone() ? "needs-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  const sub = await subscription();
  if (!sub) return "off";
  // 浏览器里还有订阅，但电脑上可能已经删掉了（例如推送服务说它失效了）
  const { subscribed } = await api.pushStatus(sub.endpoint);
  return subscribed ? "on" : "off";
}

/** 设备说明：设置里区分是哪台设备。 */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Linux";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "浏览器";
  return `${os} · ${browser}`;
}

const base64ToBytes = (b64: string) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/** 开启：请求通知权限并订阅（必须在点击按钮时调用，浏览器才会弹出权限请求）。 */
export async function enablePush(): Promise<void> {
  if ((await Notification.requestPermission()) !== "granted") throw new Error("没有通知权限：请在系统或浏览器设置里允许 projdeck 发通知");
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.pushSubscribe({ ...json, label: deviceLabel() });
}

export async function disablePush(): Promise<void> {
  const sub = await subscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint);
  await sub.unsubscribe();
}

export async function testPush(): Promise<void> {
  const sub = await subscription();
  if (!sub) throw new Error("这台设备还没开启通知");
  await api.pushTest(sub.endpoint);
}
