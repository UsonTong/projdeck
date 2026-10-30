import type { ServerResponse } from "node:http";
import type { PushPayload } from "./push.ts";

/**
 * 给 projdeck 安卓 App 的通知通道（Server-Sent Events）：App 在后台保持一条连接，
 * 收到就显示系统通知。不经过谷歌的推送服务（国内网络收不到），与网页推送（PushService）并行。
 */
export class NotifyStream {
  private readonly clients = new Set<ServerResponse>();

  get count(): number {
    return this.clients.size;
  }

  add(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", connection: "keep-alive" });
    res.write(": connected\n\n");
    this.clients.add(res);
    // 定时发心跳：手机切网络时尽快发现连接断了
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  send(payload: PushPayload): number {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) res.write(data);
    return this.clients.size;
  }
}
