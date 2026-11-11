import type { Session } from "@projdeck/shared";
import type { HerdrClient } from "./herdr/client.ts";
import type { NotifyStream } from "./notifyStream.ts";
import type { PushPayload, PushService } from "./push.ts";
import type { ProjdeckService } from "./service.ts";

/** 「需处理」要持续这么久才通知：自动信任文件夹之类会被立刻处理掉的确认框不打扰。 */
const BLOCKED_GRACE_MS = 3_000;
const POLL_MS = 10_000;
const KIND = { claude: "Claude", codex: "Codex", pi: "Pi", harness: "DeepSeek" } as const;

/**
 * 盯着所有 agent 会话的状态，在手机上推送通知：
 * - 工作中 → 已完成：「Claude 完成了」，附上最后一句回复；
 * - 变成需处理（等待确认权限、选择选项）：「Claude 需要你处理」。
 * 不需要开着网页。正在网页上看着的会话不通知（已完成在看着时本来就不会出现，见 service.seenStatus）；
 * 项目设置里关掉通知的项目不通知。
 */
export class Notifier {
  private readonly prev = new Map<string, Session["status"]>(); // terminalId → 上次看到的状态
  private readonly blockedTimers = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private checking = false;
  private readonly service: ProjdeckService;
  private readonly herdr: HerdrClient;
  private readonly push: PushService;
  /** 安卓 App 的通知连接。 */
  private readonly stream: NotifyStream | null;

  constructor(service: ProjdeckService, herdr: HerdrClient, push: PushService, stream: NotifyStream | null = null) {
    this.service = service;
    this.herdr = herdr;
    this.push = push;
    this.stream = stream;
  }

  private send(payload: PushPayload): void {
    this.stream?.send(payload);
    void this.push.send(payload);
  }

  start(): void {
    this.herdr.on("event", this.onEvent);
    this.timer = setInterval(() => void this.check(), POLL_MS);
    void this.check();
  }

  stop(): void {
    this.herdr.off("event", this.onEvent);
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    for (const t of this.blockedTimers.values()) clearTimeout(t);
  }

  private readonly onEvent = () => {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.check(), 400);
  };

  private async check(): Promise<void> {
    // 不再因为有/无接收者而跳过：状态变化必须始终跟踪，否则手机 App 后台连接断开的那段时间里
    // 状态已经 working→idle/unknown，等它重连后 before 又变成 undefined，永远错过完成通知。
    if (this.checking) return;
    this.checking = true;
    try {
      const { overview } = await this.service.refresh();
      if (!overview.herdr.online && !overview.harness?.online) return;
      const muted = new Set(overview.projects.filter((p) => p.notify === false).map((p) => p.id));
      const entries = [
        ...overview.projects.flatMap((p) => p.sessions.map((s) => ({ s, project: p.id, projectName: p.name }))),
        ...overview.unassigned.map((s) => ({ s, project: null, projectName: null })),
      ];
      const alive = new Set<string>();
      for (const { s, project, projectName } of entries) {
        if (s.kind === "shell") continue;
        alive.add(s.terminalId);
        const before = this.prev.get(s.terminalId);
        this.prev.set(s.terminalId, s.status);
        if (before === undefined || before === s.status) continue; // 第一次看到不通知（agentd 刚启动）
        if (project && muted.has(project)) continue;
        // herdr 的会话完成后是 done；DeepSeek Harness 没有 done：完成后 agent 实例要么空闲（idle）
        // 要么已被 dsh 销毁（unknown），所以只要离开 working（且不是去等确认）都算完成
        const finished = s.status === "done"
          || (s.kind === "harness" && s.status !== "working" && s.status !== "blocked");
        if (finished && before === "working") void this.notifyDone(s, projectName);
        if (s.status === "blocked") this.scheduleBlocked(s, projectName);
      }
      for (const id of this.prev.keys()) if (!alive.has(id)) this.prev.delete(id);
    } catch {
      // herdr 暂时不可用，下一轮再试
    } finally {
      this.checking = false;
    }
  }

  private async notifyDone(s: Session, projectName: string | null): Promise<void> {
    const reply = await this.service.lastReply(s.paneId).catch(() => null);
    this.send({
      title: `${KIND[s.kind as keyof typeof KIND]} 完成了 · ${s.title}`,
      body: [projectName, reply].filter(Boolean).join("\n") || "点开查看结果",
      tag: s.paneId,
      url: `/#/s/${encodeURIComponent(s.paneId)}`,
    });
  }

  private scheduleBlocked(s: Session, projectName: string | null): void {
    clearTimeout(this.blockedTimers.get(s.terminalId));
    this.blockedTimers.set(
      s.terminalId,
      setTimeout(() => {
        this.blockedTimers.delete(s.terminalId);
        if (this.prev.get(s.terminalId) !== "blocked" || this.service.isViewed(s.terminalId)) return;
        this.send({
          title: `${KIND[s.kind as keyof typeof KIND]} 需要你处理 · ${s.title}`,
          body: [projectName, "在等你确认权限或选择选项"].filter(Boolean).join("\n"),
          tag: s.paneId,
          url: `/#/s/${encodeURIComponent(s.paneId)}`,
        });
      }, BLOCKED_GRACE_MS),
    );
  }
}
