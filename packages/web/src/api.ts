import type {
  ArchivedSession,
  CreateProjectBody,
  DirListing,
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
  startHerdr: () => request("POST", "/api/herdr/start"),
  terminalTheme: () => request<TerminalTheme>("GET", "/api/terminal-theme"),
  updateSettings: (patch: Partial<Settings>) => request<Settings>("PATCH", "/api/settings", patch),
  suggestions: () => request<ProjectSuggestion[]>("GET", "/api/projects/suggestions"),
  createProject: (body: CreateProjectBody) => request<Project>("POST", "/api/projects", body),
  updateProject: (id: string, body: UpdateProjectBody) => request<Project>("PATCH", `/api/projects/${id}`, body),
  removeProject: (id: string) => request("DELETE", `/api/projects/${id}`),
  startSession: (projectId: string, kind: SessionKind) =>
    request<{ paneId: string }>("POST", `/api/projects/${projectId}/sessions`, { kind }),

  prompt: (paneId: string, text: string, files: string[]) => request("POST", `${pane(paneId)}/prompt`, { text, files }),
  keys: (paneId: string, keys: string[]) => request("POST", `${pane(paneId)}/keys`, { keys }),
  setHidden: (paneId: string, hidden: boolean) => request("POST", `${pane(paneId)}/hidden`, { hidden }),
  close: (paneId: string) => request("POST", `${pane(paneId)}/close`),
  archive: (paneId: string) => request<ArchivedSession>("POST", `${pane(paneId)}/archive`),
  codexCandidates: (paneId: string) =>
    request<{ threadId: string; modifiedAt: string }[]>("GET", `${pane(paneId)}/codex-candidates`),
  setCodexConversation: (paneId: string, threadId: string | null) =>
    request("POST", `${pane(paneId)}/codex-conversation`, { threadId }),

  restore: (id: string) => request<{ paneId: string }>("POST", `/api/archive/${id}/restore`),
  deleteArchive: (id: string) => request("DELETE", `/api/archive/${id}`),

  upload: (projectId: string, file: Blob, filename: string) => {
    const form = new FormData();
    form.append("file", file, filename);
    return request<UploadResult>("POST", `/api/projects/${projectId}/uploads`, form);
  },
  // ---- 文件管理器（路径为项目内相对路径） ----
  listDir: (projectId: string, path: string, hidden: boolean) =>
    request<DirListing>("GET", `${files(projectId)}?path=${encodeURIComponent(path)}&hidden=${hidden ? 1 : 0}`),
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
