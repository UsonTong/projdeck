// herdr socket API（protocol 22）中 projdeck 用到的部分。
// 完整定义见 `herdr api schema --json`。

export const SUPPORTED_PROTOCOL = 22;

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: HerdrAgentStatus;
}

export interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  /** 会跟随 shell 的 cd 变化。 */
  cwd: string;
  foreground_cwd: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  agent_status: HerdrAgentStatus;
  revision: number;
}

export interface HerdrAgent extends HerdrPane {
  agent: string;
  name?: string;
  agent_session?: { agent: string; kind: string; source: string; value: string };
}

export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}
