import { useEffect, useState } from "react";

/**
 * 极简 hash 路由：
 *   #/                     总览
 *   #/s/<paneId>           会话页
 *   #/f/<projectId>/<路径>  项目文件管理器（路径为项目内相对路径，可为空）
 *   #/ccs/<栏目>            CC Switch（栏目为 usage 或应用，如 claude、codex）
 *   #/devices              设备（连进 projdeck 的手机）
 */
export type Route =
  | { kind: "overview" }
  | { kind: "session"; paneId: string }
  | { kind: "files"; projectId: string; path: string }
  | { kind: "ccswitch"; section: string }
  | { kind: "devices" }
  | { kind: "harness" }
  | { kind: "deepseek" }
  | { kind: "terminal"; paneId: string };

function parse(): Route {
  const t = /^#\/t\/(.+)$/.exec(location.hash);
  if (t) return { kind: "terminal", paneId: decodeURIComponent(t[1]!) };
  const s = /^#\/s\/(.+)$/.exec(location.hash);
  if (s) return { kind: "session", paneId: decodeURIComponent(s[1]!) };
  const f = /^#\/f\/([^/]+)\/?(.*)$/.exec(location.hash);
  if (f) return { kind: "files", projectId: decodeURIComponent(f[1]!), path: f[2] ? decodeURIComponent(f[2]) : "" };
  const c = /^#\/ccs\/?(.*)$/.exec(location.hash);
  if (c) return { kind: "ccswitch", section: decodeURIComponent(c[1] || "usage") };
  if (location.hash === "#/harness") return { kind: "harness" };
  if (location.hash === "#/ds") return { kind: "deepseek" };
  if (location.hash === "#/devices") return { kind: "devices" };
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

export function openDeepSeek(): void {
  location.hash = "#/ds";
}

export function openHarness(): void {
  location.hash = "#/harness";
}

export function openSession(paneId: string | null): void {
  location.hash = paneId ? `#/s/${encodeURIComponent(paneId)}` : "#/";
}

export function openFiles(projectId: string, path = ""): void {
  location.hash = `#/f/${encodeURIComponent(projectId)}/${encodeURIComponent(path)}`;
}

export function openDevices(): void {
  location.hash = "#/devices";
}

export function openCcSwitch(section = "usage"): void {
  location.hash = `#/ccs/${encodeURIComponent(section)}`;
}
