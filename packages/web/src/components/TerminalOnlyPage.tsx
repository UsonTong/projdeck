import { useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { themeKey, useTerminalTheme } from "@/lib/terminalTheme";
import { useWide } from "../live.ts";
import type { TerminalHandle } from "./GhosttyTerminal.tsx";
import { GhosttyTerminal } from "./GhosttyTerminal.tsx";
import { KeyBar } from "./KeyBar.tsx";

/**
 * 只包含 Ghostty 终端和手机按键条的页面，供安卓原生端用 WebView 加载：
 * 和网页终端是同一个 ghostty-web WASM 引擎，不经过 Flutter 的 xterm 渲染。
 */
export function TerminalOnlyPage({ paneId }: { paneId: string }) {
  const theme = useTerminalTheme();
  const wide = useWide();
  const term = useRef<TerminalHandle>(null);
  const [fontSize, setFontSize] = useState(0);
  const [ctrl, setCtrl] = useState(false);
  if (!theme) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const size = fontSize || theme.fontSizePx || 14;
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: theme.background }}>
      {/* GhosttyTerminal 内部靠 flex-1 撑高，外层必须是 flex 容器，否则高度塌成 0、终端空白且按 80x24 连接 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <GhosttyTerminal
          key={`${paneId}:${themeKey(theme)}`}
          ref={term}
          paneId={paneId}
          theme={theme}
          padding={{ x: 4, y: 4 }}
          fontSize={size}
          sizing="fit"
          onCtrlChange={setCtrl}
          onFontSize={(d) => setFontSize(Math.min(28, Math.max(9, size + d)))}
        />
      </div>
      <KeyBar term={term} showKeys={!wide} ctrl={ctrl} composerOpen={false} />
    </div>
  );
}
