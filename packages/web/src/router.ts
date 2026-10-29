import { useEffect, useState } from "react";

/**
 * 极简 hash 路由：
 *   #/                     总览
 *   #/s/<paneId>           会话页
 *   #/f/<projectId>/<路径>  项目文件管理器（路径为项目内相对路径，可为空）
 */
export type Route =
  | { kind: "overview" }
  | { kind: "session"; paneId: string }
  | { kind: "files"; projectId: string; path: string };

function parse(): Route {
  const s = /^#\/s\/(.+)$/.exec(location.hash);
  if (s) return { kind: "session", paneId: decodeURIComponent(s[1]!) };
  const f = /^#\/f\/([^/]+)\/?(.*)$/.exec(location.hash);
  if (f) return { kind: "files", projectId: decodeURIComponent(f[1]!), path: f[2] ? decodeURIComponent(f[2]) : "" };
  return { kind: "overview" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function openSession(paneId: string | null): void {
  location.hash = paneId ? `#/s/${encodeURIComponent(paneId)}` : "#/";
}

export function openFiles(projectId: string, path = ""): void {
  location.hash = `#/f/${encodeURIComponent(projectId)}/${encodeURIComponent(path)}`;
}
