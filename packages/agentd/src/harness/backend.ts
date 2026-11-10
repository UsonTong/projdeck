import type { HarnessStatus, SessionStatus, TranscriptPage } from "@projdeck/shared";

/** Harness 适配契约：与 herdr/PTY 无关，便于用本地假服务验证和替换传输。 */
export interface HarnessSession {
  id: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  activeAt: number | null;
  /** 还没有开始对话。只显示 projdeck 刚新建的那个，与原版侧栏一致。 */
  blank?: boolean;
}

export interface HarnessBackend {
  status(): HarnessStatus;
  configure(connectionUrl: string): Promise<void>;
  close(): void;
  list(): Promise<HarnessSession[]>;
  /** 在对应目录的 Harness 工作区里新建会话；传 null 表示未归属。 */
  create(cwd: string | null): Promise<string>;
  /** 未归属会话优先在 Harness 默认工作区里创建。 */
  createDefault?(): Promise<string>;
  prompt(id: string, text: string, files?: string[]): Promise<void>;
  cancel(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  transcript(id: string, cursor: number): Promise<TranscriptPage>;
  watch?(id: string, onPage: (page: TranscriptPage) => void): () => void;
  /** 仅供后端原版网页代理使用，绝不从状态接口返回。 */
  webTarget?(): { base: string; token: string };
}

export const harnessKey = (id: string): string => `harness:${id}`;
export const isHarnessKey = (id: string): boolean => id.startsWith("harness:");
