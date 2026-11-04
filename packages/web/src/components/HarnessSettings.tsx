import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api } from "../api.ts";
import { useLive } from "../live.ts";

/** 配置仅发到 agentd，Harness token 不放进客户端持久存储，也不在状态接口中返回。 */
export function HarnessSettings() {
  const { overview } = useLive();
  const state = overview?.harness;
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      await api.connectHarness(url.trim());
      setUrl("");
      toast.success("Harness 已接入");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-sm font-medium">
        DeepSeek Harness
        <span className="text-xs font-normal text-muted-foreground">
          {state?.online ? "已连接" : state?.configured ? "连接中断" : "未接入"}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        粘贴电脑上 dsh web 打印的本机启动链接（含 token）。连接现有服务，不经过 herdr，不修改模型配置。
      </p>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label="Harness 本机启动链接"
          placeholder="http://127.0.0.1:3080/?token=…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="min-w-0 flex-1"
        />
        <Button disabled={busy || !url.trim()} onClick={() => void connect()}>
          {busy && <Spinner />}
          {state?.configured ? "重新连接" : "接入"}
        </Button>
      </div>
      {state?.error && <p role="status" className="text-xs text-destructive">{state.error}</p>}
    </section>
  );
}
