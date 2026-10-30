import { join } from "node:path";
import webpush from "web-push";
import { configDir, readJson, writeJson } from "./config.ts";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** 设备说明（浏览器 User-Agent 的简写），设置里显示用。 */
  label: string;
  createdAt: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** 同一个 tag 的新通知替换旧的（按会话）。 */
  tag?: string;
  /** 点通知后打开的地址。 */
  url?: string;
}

/**
 * 网页推送（Web Push）：通过浏览器厂商的推送服务（Google / Apple / Mozilla）把通知发到手机。
 * VAPID 密钥第一次使用时生成，与订阅一起存在配置目录（0600）。
 */
export class PushService {
  private readonly keysFile = join(configDir, "vapid.json");
  private readonly subsFile = join(configDir, "push-subscriptions.json");
  readonly publicKey: string;
  private subs: PushSubscriptionRecord[];

  constructor() {
    let keys = readJson<{ publicKey: string; privateKey: string } | null>(this.keysFile, null);
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      writeJson(this.keysFile, keys);
    }
    this.publicKey = keys.publicKey;
    // subject 必须是 mailto: 或 https 地址，推送服务出问题时用来联系发送方
    webpush.setVapidDetails("https://github.com/UsonTong/projdeck", keys.publicKey, keys.privateKey);
    this.subs = readJson<PushSubscriptionRecord[]>(this.subsFile, []);
  }

  get count(): number {
    return this.subs.length;
  }

  has(endpoint: string): boolean {
    return this.subs.some((s) => s.endpoint === endpoint);
  }

  subscribe(sub: Omit<PushSubscriptionRecord, "createdAt">): void {
    this.subs = [...this.subs.filter((s) => s.endpoint !== sub.endpoint), { ...sub, createdAt: new Date().toISOString() }];
    writeJson(this.subsFile, this.subs);
  }

  unsubscribe(endpoint: string): void {
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    writeJson(this.subsFile, this.subs);
  }

  /** 发给所有设备（或指定的一台）。推送服务说订阅已失效（404 / 410，例如卸载了 App）时删掉它。 */
  async send(payload: PushPayload, onlyEndpoint?: string): Promise<number> {
    const targets = this.subs.filter((s) => !onlyEndpoint || s.endpoint === onlyEndpoint);
    let delivered = 0;
    await Promise.all(
      targets.map(async (s) => {
        try {
          await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
          delivered++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) this.unsubscribe(s.endpoint);
        }
      }),
    );
    return delivered;
  }
}
