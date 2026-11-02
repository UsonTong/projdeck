import type {
  ArchivedSession,
  CcSwitchStatus,
  CcUsage,
  CcUsageRange,
  CreateProjectBody,
  DeviceView,
  DirListing,
  FolderListing,
  Overview,
  Project,
  ProjectSuggestion,
  SessionKind,
  Settings,
  TerminalTheme,
  UpdateProjectBody,
  UploadResult,
} from "@projdeck/shared";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 未登录时通知 App 回到登录页。 */
export const authEvents = new EventTarget();

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(path, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && path !== "/api/auth/login") authEvents.dispatchEvent(new Event("logout"));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `请求失败（${res.status}）`);
  return data as T;
}

const pane = (paneId: string) => `/api/sessions/${encodeURIComponent(paneId)}`;
const files = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/files`;

export const api = {
  authStatus: () => request<{ authenticated: boolean; configured: boolean }>("GET", "/api/auth/status"),
  login: (password: string) => request("POST", "/api/auth/login", { password }),
  logout: () => request("POST", "/api/auth/logout"),

  overview: () => request<Overview>("GET", "/api/overview"),
  // 推送通知
  pushKey: () => request<{ publicKey: string }>("GET", "/api/push/key"),
  pushStatus: (endpoint: string) => request<{ subscribed: boolean }>("POST", "/api/push/status", { endpoint }),
  pushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string }; label: string }) =>
    request("POST", "/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => request("POST", "/api/push/unsubscribe", { endpoint }),
  pushTest: (endpoint: string) => request("POST", "/api/push/test", { endpoint }),
  startHerdr: () => request("POST", "/api/herdr/start"),
  terminalTheme: () => request<TerminalTheme>("GET", "/api/terminal-theme"),
  updateSettings: (patch: Partial<Settings>) => request<Settings>("PATCH", "/api/settings", patch),
  folders: (path: string) => request<FolderListing>("GET", `/api/folders?path=${encodeURIComponent(path)}`),
  suggestions: () => request<ProjectSuggestion[]>("GET", "/api/projects/suggestions"),
  createProject: (body: CreateProjectBody) => request<Project>("POST", "/api/projects", body),
  updateProject: (id: string, body: UpdateProjectBody) => request<Project>("PATCH", `/api/projects/${id}`, body),
  removeProject: (id: string) => request("DELETE", `/api/projects/${id}`),
  startSession: (projectId: string, kind: SessionKind) =>
    request<{ paneId: string }>("POST", `/api/projects/${projectId}/sessions`, { kind }),

  /** 不属于任何项目的新会话（在主目录里启动）。 */
  startUnassignedSession: (kind: SessionKind) => request<{ paneId: string }>("POST", "/api/sessions", { kind }),

  prompt: (paneId: string, text: string, files: string[]) => request("POST", `${pane(paneId)}/prompt`, { text, files }),
  keys: (paneId: string, keys: string[]) => request("POST", `${pane(paneId)}/keys`, { keys }),
  setHidden: (paneId: string, hidden: boolean) => request("POST", `${pane(paneId)}/hidden`, { hidden }),
  /** 拖动排序：把会话所在的 herdr 工作区移到另一个会话之前（null = 移到最后）。 */
  devices: () => request<{ devices: DeviceView[] }>("GET", "/api/devices"),
  ccswitch: () => request<CcSwitchStatus>("GET", "/api/ccswitch"),
  ccswitchSwitch: (app: string, id: string) => request<CcSwitchStatus & { launched: boolean }>("POST", "/api/ccswitch/switch", { app, id }),
  ccswitchBridge: () => request<{ available: boolean; ui: { version: string; exact: boolean } | null }>("GET", "/api/ccswitch/bridge"),
  ccswitchEnableBridge: () => request<{ available: boolean }>("POST", "/api/ccswitch/bridge/enable"),
  /** 调用电脑上 CC Switch 的命令（经调试端口转发，等同于在它界面里操作）。 */
  ccInvoke: <T,>(cmd: string, args: Record<string, unknown> = {}) =>
    request<{ result: T }>("POST", "/api/ccswitch/invoke", { cmd, args }).then((r) => r.result),
  ccswitchUsage: (range: CcUsageRange, app: string) =>
    request<CcUsage>("GET", `/api/ccswitch/usage?range=${range}${app ? `&app=${encodeURIComponent(app)}` : ""}`),
  reorderProjects: (ids: string[]) => request("POST", "/api/projects/order", { ids }),
  androidApp: () => request<{ version: string; size: number; builtAt: string } | null>("GET", "/api/app"),
  notifyTest: () => request<void>("POST", "/api/notify/test").then(() => undefined),
  rename: (paneId: string, label: string | null) => request("POST", `${pane(paneId)}/rename`, { label }),
  moveBefore: (paneId: string, beforePaneId: string | null) => request("POST", `${pane(paneId)}/move-before`, { beforePaneId }),
  moveToProject: (paneId: string, projectId: string) => request("POST", `${pane(paneId)}/project`, { projectId }),
  close: (paneId: string) => request("POST", `${pane(paneId)}/close`),
  archive: (paneId: string) => request<ArchivedSession>("POST", `${pane(paneId)}/archive`),
  codexCandidates: (paneId: string) =>
    request<{ threadId: string; modifiedAt: string }[]>("GET", `${pane(paneId)}/codex-candidates`),
  setCodexConversation: (paneId: string, threadId: string | null) =>
    request("POST", `${pane(paneId)}/codex-conversation`, { threadId }),

  restore: (id: string) => request<{ paneId: string }>("POST", `/api/archive/${id}/restore`),
  deleteArchive: (id: string) => request("DELETE", `/api/archive/${id}`),

  /** 会话的附件（终端里粘贴 / 拖入、对话输入框）：属于项目时存到项目的 .uploads/，未归属时存到共享目录。 */
  upload: (paneId: string, file: Blob, filename: string) => {
    const form = new FormData();
    form.append("file", file, filename);
    return request<UploadResult>("POST", `${pane(paneId)}/uploads`, form);
  },
  // ---- 文件管理器（路径为项目内相对路径） ----
  listDir: (projectId: string, path: string, hidden: boolean) =>
    request<DirListing>("GET", `${files(projectId)}?path=${encodeURIComponent(path)}&hidden=${hidden ? 1 : 0}`),
  /** 编辑器：完整内容与修改时间。 */
  readForEdit: (projectId: string, path: string) =>
    request<{ text: string; mtimeMs: number }>("GET", `${files(projectId)}/edit?path=${encodeURIComponent(path)}`),
  /** 保存；文件在 baseMtimeMs 之后被改过时返回 409（ApiError.status）。baseMtimeMs 为 null 表示确认覆盖。 */
  saveFile: (projectId: string, path: string, text: string, baseMtimeMs: number | null) =>
    request<{ mtimeMs: number }>("PUT", `${files(projectId)}/edit`, { path, text, baseMtimeMs }),
  readText: (projectId: string, path: string) =>
    request<{ text: string; truncated: boolean } | { binary: true }>("GET", `${files(projectId)}/text?path=${encodeURIComponent(path)}`),
  mkdir: (projectId: string, path: string, name: string) => request("POST", `${files(projectId)}/mkdir`, { path, name }),
  renameFile: (projectId: string, path: string, name: string) => request("POST", `${files(projectId)}/rename`, { path, name }),
  deleteFile: (projectId: string, path: string) => request("DELETE", `${files(projectId)}?path=${encodeURIComponent(path)}`),
  downloadUrl: (projectId: string, path: string) => `${files(projectId)}/download?path=${encodeURIComponent(path)}`,
  rawUrl: (projectId: string, path: string) => `${files(projectId)}/raw?path=${encodeURIComponent(path)}`,
  /** 上传到项目内的文件夹。用 XHR 而不是 fetch：fetch 拿不到上传进度。 */
  uploadToDir: (projectId: string, path: string, list: File[], onProgress: (ratio: number) => void) =>
    new Promise<{ name: string; size: number }[]>((resolve, reject) => {
      const form = new FormData();
      for (const f of list) form.append("file", f, f.name);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${files(projectId)}/upload?path=${encodeURIComponent(path)}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        const data = JSON.parse(xhr.responseText || "{}") as { error?: string };
        if (xhr.status === 401) authEvents.dispatchEvent(new Event("logout"));
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as unknown as { name: string; size: number }[]);
        else reject(new ApiError(xhr.status, data.error ?? `上传失败（${xhr.status}）`));
      };
      xhr.onerror = () => reject(new ApiError(0, "网络错误，上传中断"));
      xhr.send(form);
    }),

  fileUrl: (projectId: string, path: string) =>
    `/api/file?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
};
