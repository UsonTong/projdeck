import { createServer, type Server, type Socket } from "node:net";

/*
 * 远程 adb 的转发：电脑上的 adb 连 127.0.0.1:<端口>，数据经手机 App 建立的 WebSocket（/ws/adb）转给手机本机的 adbd。
 *
 * WebSocket 上跑一个很简单的多路复用（adb 会开多个连接，也会断线重连）。每个帧：
 *   [类型 1 字节][连接号 4 字节（大端）][数据]
 *   OPEN(1)  电脑 → 手机：有新的 adb 连接，手机去连本机的 adbd
 *   DATA(2)  双向：这个连接上的一段数据
 *   CLOSE(3) 双向：这个连接关闭了
 * 手机没连上时不监听端口，电脑上 adb 连接会直接被拒绝。同一时间只接受一台手机，后连的顶掉先连的。
 */

export const OPEN = 1;
export const DATA = 2;
export const CLOSE = 3;
/** websocket 插件限制单个消息 64KB，帧头占 5 字节 */
const CHUNK = 32 * 1024;
const PAUSE_ABOVE = 8 * 1024 * 1024;
const RESUME_BELOW = 1024 * 1024;

export interface PhoneLink {
  send(frame: Buffer): void;
  /** 已交给 WebSocket 但还没发出去的字节数，用来做背压 */
  bufferedAmount(): number;
  close(): void;
}

/** 手机连上后和每隔一阵发来的自我介绍（WebSocket 文本消息，JSON）。服务器只挑认识的字段，字符串截断。 */
export interface DeviceReport {
  id: string;
  model: string;
  brand: string;
  os: string;
  battery: number | null;
  charging: boolean | null;
  network: "wifi" | "mobile" | "none" | null;
  vpn: boolean | null;
  tcpMode: boolean | null;
  appVersion: string | null;
}

const str = (v: unknown, max = 64): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** 把手机发来的 JSON 整理成 DeviceReport；缺少设备编号时返回 null。 */
export function parseReport(raw: unknown): DeviceReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const battery = typeof r.battery === "number" && r.battery >= 0 && r.battery <= 100 ? Math.round(r.battery) : null;
  const network = r.network === "wifi" || r.network === "mobile" || r.network === "none" ? r.network : null;
  return {
    id,
    model: str(r.model) ?? "未知设备",
    brand: str(r.brand) ?? "",
    os: str(r.os) ?? "",
    battery,
    charging: bool(r.charging),
    network,
    vpn: bool(r.vpn),
    tcpMode: bool(r.tcpMode),
    appVersion: str(r.appVersion, 32),
  };
}

export interface RelayStatus {
  connected: boolean;
  /** 电脑上 adb 要连的端口（手机没连上时为 null） */
  port: number | null;
  connections: number;
  /** 手机连上的时间（毫秒时间戳） */
  since: number | null;
}

const frame = (type: number, id: number, payload?: Buffer): Buffer => {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(id, 1);
  return payload ? Buffer.concat([head, payload]) : head;
};

export class AdbRelay {
  private readonly port: number;
  private readonly host: string;
  private server: Server | null = null;
  private phone: PhoneLink | null = null;
  private since: number | null = null;
  /** 最近一台连上来的手机的自我介绍；手机断开后保留，用来显示「最近在线」 */
  private report: DeviceReport | null = null;
  private lastSeen: number | null = null;
  private readonly conns = new Map<number, Socket>();
  private nextId = 1;
  private readonly log: (msg: string) => void;

  constructor(port: number, host = "127.0.0.1", log: (msg: string) => void = () => {}) {
    this.port = port;
    this.host = host;
    this.log = log;
  }

  status(): RelayStatus {
    const address = this.server?.address();
    return {
      connected: this.phone !== null,
      port: this.phone && address && typeof address === "object" ? address.port : null,
      connections: this.conns.size,
      since: this.since,
    };
  }

  /** 当前连着的手机，或最近一次连过的（online=false）。没有连过任何手机时为 null。 */
  device(): { report: DeviceReport; online: boolean; since: number | null; lastSeen: number } | null {
    if (!this.report || this.lastSeen === null) return null;
    return { report: this.report, online: this.phone !== null, since: this.since, lastSeen: this.phone ? Date.now() : this.lastSeen };
  }

  /** 手机发来了自我介绍（只接受当前连着的那台）。 */
  setReport(link: PhoneLink, report: DeviceReport): void {
    if (this.phone !== link) return;
    this.report = report;
    this.lastSeen = Date.now();
  }

  /** 手机连上来了。返回收到手机帧时要调用的 receive，以及手机断开时调用的 detach。 */
  attach(link: PhoneLink): { receive(data: Buffer): void; report(report: DeviceReport): void; detach(): void } {
    this.dropPhone();
    this.phone = link;
    this.since = Date.now();
    this.listen();
    this.log("手机已连上，adb 转发开始监听");
    return {
      receive: (data) => this.onFrame(link, data),
      report: (report) => this.setReport(link, report),
      detach: () => {
        if (this.phone !== link) return;
        this.dropPhone();
        this.log("手机断开，adb 转发停止监听");
      },
    };
  }

  /** 关闭所有连接并停止监听。 */
  stop(): void {
    this.dropPhone();
  }

  private dropPhone(): void {
    const old = this.phone;
    if (old) this.lastSeen = Date.now();
    this.phone = null;
    this.since = null;
    for (const s of this.conns.values()) s.destroy();
    this.conns.clear();
    this.server?.close();
    this.server = null;
    if (old) {
      try {
        old.close();
      } catch {
        // 已经断开
      }
    }
  }

  private listen(): void {
    const server = createServer((socket) => this.onConnection(socket));
    server.on("error", (err) => this.log(`adb 转发端口 ${this.port} 监听失败：${err.message}`));
    server.listen(this.port, this.host);
    this.server = server;
  }

  private onConnection(socket: Socket): void {
    const link = this.phone;
    if (!link) return void socket.destroy();
    const id = this.nextId++;
    this.conns.set(id, socket);
    socket.setNoDelay(true);
    link.send(frame(OPEN, id));
    let throttled = false;
    socket.on("data", (buf: Buffer) => {
      for (let i = 0; i < buf.length; i += CHUNK) link.send(frame(DATA, id, buf.subarray(i, i + CHUNK)));
      // 手机或网络跟不上时先停止读电脑这一端，免得内存越积越多
      if (!throttled && link.bufferedAmount() > PAUSE_ABOVE) {
        throttled = true;
        socket.pause();
        const timer = setInterval(() => {
          if (socket.destroyed) return clearInterval(timer);
          if (link.bufferedAmount() < RESUME_BELOW) {
            clearInterval(timer);
            throttled = false;
            socket.resume();
          }
        }, 100);
      }
    });
    socket.on("close", () => {
      if (this.conns.get(id) !== socket) return;
      this.conns.delete(id);
      if (this.phone === link) link.send(frame(CLOSE, id));
    });
    socket.on("error", () => {});
  }

  private onFrame(link: PhoneLink, data: Buffer): void {
    if (this.phone !== link || data.length < 5) return;
    const type = data[0];
    const id = data.readUInt32BE(1);
    const socket = this.conns.get(id);
    if (!socket) return;
    if (type === DATA) socket.write(data.subarray(5));
    else if (type === CLOSE) {
      this.conns.delete(id);
      socket.destroy();
    }
  }
}
