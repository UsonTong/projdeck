import type { TerminalTheme } from "@projdeck/shared";
import { FitAddon, init, Terminal } from "ghostty-web";
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Spinner } from "@/components/ui/spinner";
import { attachMouse, attachTextInput } from "@/lib/ghosttyInput";
import { copyText } from "@/lib/clipboard";
import { patchRenderer } from "@/lib/ghosttyRender";

/**
 * WASM 只需初始化一次。同时等待字体加载完成：终端画在 canvas 上，字体晚到不会触发重绘，
 * 格子尺寸也会按回退字体算错。
 */
let ready: Promise<void> | null = null;
const ensureInit = () =>
  (ready ??= Promise.all([
    init(),
    ...['16px "projdeck JetBrains Mono"', 'bold 16px "projdeck JetBrains Mono"', 'italic 16px "projdeck JetBrains Mono"'].map((f) =>
      document.fonts.load(f).catch(() => []),
    ),
    document.fonts.load('16px "Symbols Nerd Font Mono"', "\ue0b6").catch(() => []),
  ]).then(() => undefined));

/** 切到后台超过这么久就断开 attach，让电脑上的 pane 恢复原尺寸。 */
const BACKGROUND_DETACH_MS = 15_000;

/** 与原生 Ghostty 一致的字体栈：用户配置的字体 → Ghostty 默认的 JetBrains Mono → 图标 → 中文。 */
function fontFamily(theme: TerminalTheme): string {
  return [
    ...theme.fontFamily.map((f) => `"${f}"`),
    // Ghostty 的默认字体就是内置的 JetBrains Mono；打包进来，手机和没装这个字体的电脑也一样
    '"projdeck JetBrains Mono"',
    '"Symbols Nerd Font Mono"',
    '"Noto Sans Mono CJK SC"',
    '"PingFang SC"',
    '"Microsoft YaHei"',
    "monospace",
  ].join(", ");
}

type Renderer = { fontSize: number; metrics: { width: number; height: number }; remeasureFont(): void };
const rendererOf = (term: Terminal | null) => (term as unknown as { renderer?: Renderer } | null)?.renderer;

/** 把 Ghostty 配置转成 ghostty-web 的主题。 */
function ghosttyWebTheme(t: TerminalTheme) {
  const p = t.palette;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorText,
    selectionBackground: t.selectionBackground,
    selectionForeground: t.selectionForeground,
    black: p[0], red: p[1], green: p[2], yellow: p[3], blue: p[4], magenta: p[5], cyan: p[6], white: p[7],
    brightBlack: p[8], brightRed: p[9], brightGreen: p[10], brightYellow: p[11],
    brightBlue: p[12], brightMagenta: p[13], brightCyan: p[14], brightWhite: p[15],
  };
}

export interface TerminalHandle {
  /** 向终端发送原始输入（快捷键条使用）。 */
  send(data: string): void;
  /** 以粘贴方式输入文本（支持 bracketed paste，agent 会当作一次粘贴处理）。 */
  paste(text: string): void;
  focus(): void;
  /** 下一个输入的字符按 Ctrl 组合发送。 */
  armCtrl(on: boolean): void;
  /** DECCKM（应用光标模式）下方向键需要用 ESC O 前缀。 */
  appCursor(): boolean;
}

type Status = "connecting" | "open" | "closed" | "error";

interface Props {
  paneId: string;
  /** 本机 Ghostty 的配色与字体。只在创建时读取。 */
  theme: TerminalTheme;
  /** 终端四周留白（px），对应 Ghostty 的 window-padding。 */
  padding: { x: number; y: number };
  /** 字号（px）。变化时原地重新测量格子，不重新连接。跟随电脑尺寸时这是上限，放不下会再缩小。 */
  fontSize: number;
  /** 尺寸策略：适配网页 / 跟随电脑 / 自动（见 agentd 的 TerminalSizing）。变化时重新连接。 */
  sizing: "auto" | "fit" | "desktop";
  /** 粘贴或拖入文件（图片或任意文件）时调用，返回上传后的本地路径；返回 null 表示不处理。 */
  onFile?: (file: File) => Promise<string | null>;
  onCtrlChange?: (armed: boolean) => void;
  /** 字号调整：+1 放大，-1 缩小，0 恢复默认（Ctrl+= / Ctrl+- / Ctrl+0）。 */
  onFontSize?: (delta: 1 | -1 | 0) => void;
  /** 右键菜单「上传文件…」。 */
  onPickFile?: () => void;
  /** 右键菜单「切换到对话」；临时终端不提供。 */
  onSwitchToChat?: () => void;
}


/**
 * 交互式网页终端：Ghostty 的 VT 引擎（WASM）渲染，通过 /ws/term 连接 `herdr agent attach`。
 * 与电脑上的 herdr 看到的是同一个终端，键盘、鼠标、粘贴都直接进入 pane。
 */
export const GhosttyTerminal = forwardRef<TerminalHandle, Props>(function GhosttyTerminal(props, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ctrlArmed = useRef(false);
  /** 服务端要求跟随电脑上的尺寸时的行列数；为空时按容器大小自适应。 */
  const followRef = useRef<{ cols: number; rows: number } | null>(null);
  const originalFit = useRef<(() => void) | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState("");
  const [reconnectTick, setReconnectTick] = useState(0);
  // 未连接状态持续一会儿才显示覆盖层：改尺寸、切回前台等短暂重连不闪「已断开」
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    if (status === "open") return setOverlay(false);
    if (status === "error") return setOverlay(true);
    const t = setTimeout(() => setOverlay(true), status === "connecting" ? 600 : 1500);
    return () => clearTimeout(t);
  }, [status]);

  const send = (data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "i", d: data }));
  };

  /** 所有用户输入的统一出口：处理软键盘 Ctrl 粘滞键后发送。 */
  const input = (data: string) => {
    if (ctrlArmed.current && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 0x40 && code <= 0x5f) data = String.fromCharCode(code & 0x1f);
      ctrlArmed.current = false;
      propsRef.current.onCtrlChange?.(false);
    }
    send(data);
  };

  useImperativeHandle(ref, () => ({
    send,
    paste: (text) => termRef.current?.paste(text),
    focus: () => termRef.current?.focus(),
    armCtrl: (on) => {
      ctrlArmed.current = on;
      propsRef.current.onCtrlChange?.(on);
    },
    appCursor: () => termRef.current?.getMode(1, false) ?? false,
  }));

  const copySelection = async () => {
    const text = termRef.current?.getSelection() ?? "";
    if (!text) return;
    if (await copyText(text)) toast.success("已复制");
    else toast.error("复制失败");
  };

  /** 右键菜单「粘贴」：剪贴板里有图片就上传后粘贴路径，有文字就粘贴文字。 */
  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const image = item.types.find((t) => t.startsWith("image/"));
        if (image && propsRef.current.onFile) {
          const blob = await item.getType(image);
          const file = new File([blob], `clipboard.${image.split("/")[1]}`, { type: image });
          const path = await propsRef.current.onFile(file);
          if (path) termRef.current?.paste(`${path} `);
        } else if (item.types.includes("text/plain")) {
          const text = await (await item.getType("text/plain")).text();
          if (text) termRef.current?.paste(text);
        }
      }
    } catch {
      // 浏览器只在 HTTPS 或 localhost 下允许网页读取剪贴板，且需要用户授权
      toast.error("浏览器不允许读取剪贴板，请直接按 Ctrl+V 粘贴（图片和文件也可以）");
    }
    termRef.current?.focus();
  };

  // 创建终端（只做一次）
  useEffect(() => {
    let disposed = false;
    let fit: FitAddon | undefined;
    const cleanups: (() => void)[] = [];
    void ensureInit().then(() => {
      if (disposed || !container.current) return;
      const { theme } = propsRef.current;
      const term = new Terminal({
        fontSize: propsRef.current.fontSize,
        fontFamily: fontFamily(theme),
        theme: ghosttyWebTheme(theme),
        cursorBlink: true,
        scrollback: 5000,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      // 跟随电脑尺寸时不按容器自适应行列数，而是缩放字号（容器尺寸变化时同样走这里）
      originalFit.current = fit.fit.bind(fit);
      fit.fit = () => (followRef.current ? applyFollow() : originalFit.current?.());
      term.open(container.current);
      // 修正格子尺寸、自绘制表符 / 方块 / Powerline，接近原生 Ghostty 的观感
      patchRenderer(term);
      fit.fit();
      fit.observeResize();
      termRef.current = term;
      fitRef.current = fit;

      // 补齐鼠标上报（点击 / 拖动 / 滚轮交给 herdr 和程序）与输入法定位
      cleanups.push(attachMouse(term, wrap.current!, send));
      cleanups.push(
        attachTextInput(term, container.current, {
          fontFamily: fontFamily(theme),
          fontSize: propsRef.current.fontSize,
          foreground: theme.foreground,
          background: theme.background,
        }),
      );

      // 与 Ghostty 一致的快捷键：Ctrl+Shift+C 复制；Ctrl+= / Ctrl+- / Ctrl+0 调字号（同时拦住浏览器缩放）
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey) return false;
        if (e.shiftKey && e.code === "KeyC") {
          void copySelection();
          return true;
        }
        const font = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1, Digit0: 0, Numpad0: 0 } as const;
        const delta = font[e.code as keyof typeof font];
        if (delta !== undefined && propsRef.current.onFontSize) {
          propsRef.current.onFontSize(delta);
          return true;
        }
        return false;
      });

      term.onData(input);
      term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "r", c: cols, r: rows }));
      });
      setReconnectTick((n) => n + 1); // 终端就绪后建立连接
    });
    return () => {
      disposed = true;
      cleanups.forEach((c) => c());
      fit?.dispose();
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, []);

  /**
   * 跟随电脑尺寸：行列数固定为电脑上的，字号缩小到整个终端能放进容器（不超过设定的字号）。
   * 测量后的格子会对齐设备像素，按比例估算后再逐步微调。
   */
  function applyFollow() {
    const term = termRef.current;
    const follow = followRef.current;
    const el = container.current;
    const renderer = rendererOf(term);
    if (!term || !follow || !el || !renderer) return;
    const fits = () => follow.cols * renderer.metrics.width <= el.clientWidth && follow.rows * renderer.metrics.height <= el.clientHeight;
    const setSize = (size: number) => {
      if (renderer.fontSize === size) return;
      renderer.fontSize = size;
      renderer.remeasureFont();
    };
    setSize(propsRef.current.fontSize);
    for (let i = 0; i < 40 && !fits() && renderer.fontSize > 6; i++) {
      const ratio = Math.min(el.clientWidth / (follow.cols * renderer.metrics.width), el.clientHeight / (follow.rows * renderer.metrics.height));
      setSize(Math.max(6, Math.min(renderer.fontSize - 0.5, Math.floor(renderer.fontSize * ratio * 2) / 2)));
    }
    if (term.cols !== follow.cols || term.rows !== follow.rows) term.resize(follow.cols, follow.rows);
  }

  // 字号原地生效：重新测量格子并调整行列数，不重新挂载、不断开连接
  useEffect(() => {
    const term = termRef.current;
    const renderer = rendererOf(term);
    if (!term || !renderer || renderer.fontSize === props.fontSize) return;
    renderer.fontSize = props.fontSize;
    renderer.remeasureFont();
    // 下一帧渲染会发现画布尺寸与新格子不符，自动整屏重绘；fit 按新格子算出行列数并通知 herdr
    fitRef.current?.fit();
  }, [props.fontSize]);

  // 连接 / 重连 attach
  useEffect(() => {
    const term = termRef.current;
    if (!term || reconnectTick === 0) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // 谁在操作谁优先（尺寸策略为「自动」时）：浏览器窗口有焦点就用网页的尺寸，切到别处（如电脑上的 Ghostty）就让回给电脑
    const isActive = () => document.visibilityState === "visible" && document.hasFocus();
    const params = new URLSearchParams({
      pane: props.paneId,
      cols: String(term.cols),
      rows: String(term.rows),
      sizing: props.sizing,
      active: isActive() ? "1" : "0",
    });
    const ws = new WebSocket(`${proto}://${location.host}/ws/term?${params}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    let intentional = false;
    setStatus("connecting");
    setError("");
    // herdr 在 attach 时会完整重绘。旧画面先留着，等新连接的第一段输出到了再清，避免重连时闪一下空白
    let firstChunk = true;

    ws.onopen = () => setStatus("open");
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        if (firstChunk) {
          firstChunk = false;
          term.reset();
        }
        term.write(new Uint8Array(ev.data));
        return;
      }
      const msg = JSON.parse(String(ev.data)) as
        | { t: "error"; message: string }
        | { t: "exit" }
        | { t: "size"; follow: { cols: number; rows: number } | null };
      if (msg.t === "size") {
        const was = followRef.current;
        followRef.current = msg.follow;
        if (msg.follow) applyFollow();
        else if (was) {
          // 不再跟随：恢复设定字号，按容器自适应并通知服务端
          const renderer = rendererOf(term);
          if (renderer) {
            renderer.fontSize = propsRef.current.fontSize;
            renderer.remeasureFont();
          }
          // FitAddon 记着跟随之前自己定的行列数，算出来相同就不动；跟随期间行列数被直接改过，先让它忘掉
          const fitState = fitRef.current as unknown as { _lastCols?: number; _lastRows?: number } | null;
          if (fitState) fitState._lastCols = fitState._lastRows = undefined;
          originalFit.current?.();
        }
        return;
      }
      if (msg.t === "error") {
        intentional = true;
        setError(msg.message);
        setStatus("error");
      }
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      if (!intentional) setStatus((s) => (s === "error" ? s : "closed"));
    };

    // 切到后台一段时间后断开，回到前台自动重连
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenTimer = setTimeout(() => {
          intentional = true;
          ws.close();
          setStatus("closed");
        }, BACKGROUND_DETACH_MS);
      } else {
        clearTimeout(hiddenTimer);
        if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) setReconnectTick((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    // 焦点在窗口间切换时会连着触发好几个事件，稍等稳定后再报告
    let lastActive = isActive();
    let activeTimer: ReturnType<typeof setTimeout> | undefined;
    const reportActive = () => {
      clearTimeout(activeTimer);
      activeTimer = setTimeout(() => {
        const active = isActive();
        if (active === lastActive) return;
        lastActive = active;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "a", active }));
      }, 150);
    };
    window.addEventListener("focus", reportActive);
    window.addEventListener("blur", reportActive);
    document.addEventListener("visibilitychange", reportActive);

    return () => {
      intentional = true;
      clearTimeout(hiddenTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(activeTimer);
      window.removeEventListener("focus", reportActive);
      window.removeEventListener("blur", reportActive);
      document.removeEventListener("visibilitychange", reportActive);
      ws.close();
    };
  }, [props.paneId, props.sizing, reconnectTick]);

  // 意外断线 1.5 秒后自动重连
  useEffect(() => {
    if (status !== "closed" || document.visibilityState === "hidden") return;
    const t = setTimeout(() => setReconnectTick((n) => n + 1), 1500);
    return () => clearTimeout(t);
  }, [status]);

  /*
   * 补上 ghostty-web 漏掉的输入。
   * ghostty-web 只从 keydown 和输入法 compositionend 取文字，并拦截了所有 beforeinput。
   * Android 软键盘（keyCode 229）、语音输入、滑行输入、自动补全都只通过 beforeinput 送达文字，会被吞掉。
   * 它处理过的按键会 preventDefault(keydown)，浏览器就不会再触发 beforeinput，所以这里不会重复输入。
   * 监听挂在外层并使用捕获阶段，赶在 ghostty-web 的拦截之前。
   */
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    /** 最近一次按下的键：区分「真的按了退格」和「输入法自己删除周围文字」。 */
    let lastKey = { key: "", keyCode: 0, at: 0 };
    const onBeforeInput = (e: InputEvent) => {
      if (e.isComposing) return; // 输入法组字由 compositionend 处理
      let data: string | null = null;
      switch (e.inputType) {
        case "insertText":
          data = e.data;
          break;
        case "insertLineBreak":
        case "insertParagraph":
          data = "\r";
          break;
        case "deleteContentBackward": {
          // 只有刚按过退格键（或安卓软键盘的 229 键）才算退格。
          // 桌面输入法（fcitx / ibus）上屏时会主动删除光标周围的文字，那不是用户要删终端里的字。
          const recent = Date.now() - lastKey.at < 300;
          const backspace = lastKey.key === "Backspace" || (lastKey.keyCode === 229 && lastKey.key === "Unidentified");
          if (!recent || !backspace) {
            e.preventDefault();
            return;
          }
          data = "\x7f";
          break;
        }
        default:
          return; // 组字、粘贴（有专门的 paste 处理）、自动更正替换等不处理
      }
      e.preventDefault();
      if (data) input(data);
    };
    /*
     * 普通字符键不让 ghostty-web 在 keydown 里直接发送，而是交给浏览器的文字输入（上面的 beforeinput）。
     * 原因：Linux 上的输入法（fcitx / ibus）开始组字的那一键，keydown 里是普通字母而不是 229，
     * ghostty-web 会立刻把它发出去，组字结果里又有一次，于是出现「hhai」。
     * 走 beforeinput 时，被输入法接管的键不会产生 insertText，自然不会重复。
     */
    const onKeyDown = (e: KeyboardEvent) => {
      lastKey = { key: e.key, keyCode: e.keyCode, at: Date.now() };
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
      e.stopPropagation();
    };
    el.addEventListener("beforeinput", onBeforeInput, true);
    el.addEventListener("keydown", onKeyDown, true);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput, true);
      el.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // 粘贴 / 拖入文件：上传后把路径粘贴进终端。图片会被 agent 识别为图片附件，其他文件 agent 会自己读取
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const handleFiles = async (files: File[]) => {
      for (const f of files) {
        const path = await propsRef.current.onFile?.(f);
        if (path) termRef.current?.paste(`${path} `);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length || !propsRef.current.onFile) return;
      e.preventDefault();
      e.stopPropagation();
      void handleFiles(files);
    };
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length || !propsRef.current.onFile) return;
      e.preventDefault();
      void handleFiles(files);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    el.addEventListener("paste", onPaste, true);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragover", onDragOver);
    return () => {
      el.removeEventListener("paste", onPaste, true);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragover", onDragOver);
    };
  }, []);

  const [hasSelection, setHasSelection] = useState(false);

  return (
    <ContextMenu onOpenChange={(open) => (open ? setHasSelection(!!termRef.current?.hasSelection()) : termRef.current?.focus())}>
      <ContextMenuTrigger asChild>
        <div ref={wrap} className="relative min-h-0 flex-1" style={{ background: props.theme.background }}>
          {/* ghostty-web 会在这个容器里放 canvas；键盘焦点在 attachTextInput 放进来的 textarea 上 */}
          <div
            ref={container}
            className="absolute overflow-hidden outline-none"
            style={{ inset: `${props.padding.y}px ${props.padding.x}px` }}
            onClick={() => termRef.current?.focus()}
          />
          {overlay && status !== "open" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-6 text-center text-sm text-muted-foreground">
              {status === "error" ? (
                <>
                  <TriangleAlertIcon className="size-5 text-destructive" />
                  <p className="max-w-sm">{error}</p>
                  <Button variant="outline" size="sm" onClick={() => setReconnectTick((n) => n + 1)}>
                    <RotateCwIcon data-icon="inline-start" />
                    重试
                  </Button>
                </>
              ) : (
                <>
                  <Spinner className="size-5" />
                  {status === "connecting" ? "连接中…" : "已断开，正在重连…"}
                </>
              )}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      {/* 仿 Ghostty 的右键菜单：纯文字条目，右侧是快捷键 */}
      <ContextMenuContent className="w-56">
        <ContextMenuItem disabled={!hasSelection} onSelect={() => void copySelection()}>
          复制
          <ContextMenuShortcut>Ctrl+Shift+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void pasteFromClipboard()}>
          粘贴
          <ContextMenuShortcut>Ctrl+Shift+V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => termRef.current?.selectAll()}>全选</ContextMenuItem>
        <ContextMenuSeparator />
        {props.onPickFile && <ContextMenuItem onSelect={props.onPickFile}>上传文件…</ContextMenuItem>}
        {props.onSwitchToChat && <ContextMenuItem onSelect={props.onSwitchToChat}>切换到对话</ContextMenuItem>}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => setReconnectTick((n) => n + 1)}>重新连接</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
