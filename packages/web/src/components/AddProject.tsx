import { useEffect, useState, type FormEvent } from "react";
import type { ProjectSuggestion } from "@projdeck/shared";
import { api } from "../api.ts";

export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"new" | "import">("new");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.suggestions().then(setSuggestions, () => {});
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => (tab === "new" ? api.createProject({ name: name.trim() }) : api.createProject({ path: path.trim() })));
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="tabs">
          <button type="button" className={tab === "new" ? "on" : ""} onClick={() => setTab("new")}>
            新建项目
          </button>
          <button type="button" className={tab === "import" ? "on" : ""} onClick={() => setTab("import")}>
            导入已有文件夹
          </button>
        </div>

        {tab === "new" ? (
          <>
            <input placeholder="项目名，如 my-app" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <p className="hint">会在 ~/Projects 下创建同名文件夹。</p>
          </>
        ) : (
          <>
            <input
              placeholder="绝对路径，如 ~/Repositories/wx-monitor"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {suggestions.length > 0 && (
              <div className="suggestions">
                <div className="hint">herdr 中正在使用的目录：</div>
                {suggestions.map((s) => (
                  <button
                    type="button"
                    key={s.path}
                    className="suggestion"
                    disabled={busy}
                    onClick={() => void run(() => api.createProject({ path: s.path }))}
                  >
                    <span>{s.name}</span>
                    <span className="row-sub">
                      {s.path} · {s.sessionCount} 个会话
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {error && <p className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy || (tab === "new" ? !name.trim() : !path.trim())}>
            {tab === "new" ? "创建" : "导入"}
          </button>
        </div>
      </form>
    </div>
  );
}
