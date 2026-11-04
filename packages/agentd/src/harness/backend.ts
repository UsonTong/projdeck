import type { HarnessStatus, SessionStatus, TranscriptPage } from "@projdeck/shared";

/** Harness 适配契约：与 herdr/PTY 无关，便于用本地假服务验证和替换传输。 */
export interface HarnessSession {
  id: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  activeAt: number | null;
}

export interface HarnessBackend {
  status(): HarnessStatus;
  configure(connectionUrl: string): Promise<void>;
  close(): void;
  list(): Promise<HarnessSession[]>;
  create(cwd: string): Promise<string>;
  prompt(id: string, text: string, files?: string[]): Promise<void>;
  cancel(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  transcript(id: string, cursor: number): Promise<TranscriptPage>;
  watch?(id: string, onPage: (page: TranscriptPage) => void): () => void;
}

export const harnessKey = (id: string): string => `harness:${id}`;
export const isHarnessKey = (id: string): boolean => id.startsWith("harness:");
