import { useState, type FormEvent } from "react";
import { api } from "../api.ts";

export function Login({ configured, onSuccess }: { configured: boolean; onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login" onSubmit={submit}>
      <h1>projdeck</h1>
      {!configured && (
        <p className="hint">
          尚未设置密码。请在电脑上运行：
          <code>pnpm --filter @projdeck/agentd cli set-password</code>
        </p>
      )}
      <input
        type="password"
        autoComplete="current-password"
        placeholder="密码"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      <button type="submit" className="primary" disabled={busy || !password}>
        {busy ? "登录中…" : "登录"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
