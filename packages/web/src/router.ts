import { useEffect, useState } from "react";

/** 极简 hash 路由：#/ 为总览，#/s/<paneId> 为会话页。 */
function currentPane(): string | null {
  const m = /^#\/s\/(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function useRoute(): string | null {
  const [paneId, setPaneId] = useState(currentPane);
  useEffect(() => {
    const on = () => setPaneId(currentPane());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return paneId;
}

export function openSession(paneId: string | null): void {
  location.hash = paneId ? `#/s/${encodeURIComponent(paneId)}` : "#/";
}
