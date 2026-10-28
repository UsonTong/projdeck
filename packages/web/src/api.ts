import type {
  ArchivedSession,
  CreateProjectBody,
  Overview,
  Project,
  ProjectSuggestion,
  SessionKind,
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

export const api = {
  authStatus: () => request<{ authenticated: boolean; configured: boolean }>("GET", "/api/auth/status"),
  login: (password: string) => request("POST", "/api/auth/login", { password }),
  logout: () => request("POST", "/api/auth/logout"),

  overview: () => request<Overview>("GET", "/api/overview"),
  suggestions: () => request<ProjectSuggestion[]>("GET", "/api/projects/suggestions"),
  createProject: (body: CreateProjectBody) => request<Project>("POST", "/api/projects", body),
  updateProject: (id: string, body: UpdateProjectBody) => request<Project>("PATCH", `/api/projects/${id}`, body),
  removeProject: (id: string) => request("DELETE", `/api/projects/${id}`),
  startSession: (projectId: string, kind: SessionKind) =>
    request<{ paneId: string }>("POST", `/api/projects/${projectId}/sessions`, { kind }),

  prompt: (paneId: string, text: string, images: string[]) => request("POST", `${pane(paneId)}/prompt`, { text, images }),
  keys: (paneId: string, keys: string[]) => request("POST", `${pane(paneId)}/keys`, { keys }),
  setHidden: (paneId: string, hidden: boolean) => request("POST", `${pane(paneId)}/hidden`, { hidden }),
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
  fileUrl: (projectId: string, path: string) =>
    `/api/file?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
};
