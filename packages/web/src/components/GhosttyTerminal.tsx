import { FitAddon, init, Terminal } from "ghostty-web";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

/**
 * WASM 只需初始化一次。同时等待 Nerd Font 图标字体加载完成：
 * 终端画在 canvas 上，字体晚到不会触发重绘，提示符里的图标会一直显示成方框。
 */
let ready: Promise<void> | null = null;
const ensureInit = () =>
  (ready ??= Promise.all([
    init(),
    document.fonts.load('16px "Symbols Nerd Font Mono"', "\ue0b6").catch(() => []),
  ]).then(() => undefined));

/** 切到后台超过这么久就断开 attach，让电脑上的 pane 恢复原尺寸。 */
const BACKGROUND_DETACH_MS = 15_000;

const FONT_FAMILY =
  '"JetBrains Mono", "SF Mono", Menlo, "Cascadia Mono", "DejaVu Sans Mono", "Symbols Nerd Font Mono", "Noto Sans Mono CJK SC", "Droid Sans Mono", monospace';

const THEME = {
  background: "#0f1114",
  foreground: "#e6e6e6",
  cursor: "#e8916b",
  cursorAccent: "#0f1114",
  selectionBackground: "#3a4252",
  black: "#1b1e23",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d7dae0",
  brightBlack: "#5c636d",
  brightRed: "#ef8891",
  brightGreen: "#b5e08f",
  brightYellow: "#f0d197",
  brightBlue: "#82c4ff",
  brightMagenta: "#d896ea",
  brightCyan: "#76cfd9",
  brightWhite: "#ffffff",
};

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
  /** 只在创建时读取；改字号时由父组件用 key 重新挂载（herdr 在 attach 时会完整重绘）。 */
  fontSize: number;
  /** 粘贴或拖入图片时调用，返回上传后的本地路径；返回 null 表示不处理。 */
  onImage?: (file: File) => Promise<string | null>;
  onCtrlChange?: (armed: boolean) => void;
}

/**
 * 交互式网页终端：Ghostty 的 VT 引擎（WASM）渲染，通过 /ws/term 连接 `herdr agent attach`。
 * 与电脑上的 herdr 看到的是同一个终端，键盘、鼠标、粘贴都直接进入 pane。
 */
export const GhosttyTerminal = forwardRef<TerminalHandle, Props>(function GhosttyTerminal(props, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ctrlArmed = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState("");
  const [reconnectTick, setReconnectTick] = useState(0);

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

  // 创建终端（只做一次）
  useEffect(() => {
    let disposed = false;
    let fit: FitAddon | undefined;
    void ensureInit().then(() => {
      if (disposed || !container.current) return;
      const term = new Terminal({
        fontSize: propsRef.current.fontSize,
        fontFamily: FONT_FAMILY,
        theme: THEME,
        cursorBlink: true,
        scrollback: 5000,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container.current);
      fit.fit();
      fit.observeResize();
      termRef.current = term;

      term.onData(input);
      term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "r", c: cols, r: rows }));
      });
      setReconnectTick((n) => n + 1); // 终端就绪后建立连接
    });
    return () => {
      disposed = true;
      fit?.dispose();
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, []);

  // 连接 / 重连 attach
  useEffect(() => {
    const term = termRef.current;
    if (!term || reconnectTick === 0) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const params = new URLSearchParams({ pane: props.paneId, cols: String(term.cols), rows: String(term.rows) });
    const ws = new WebSocket(`${proto}://${location.host}/ws/term?${params}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    let intentional = false;
    setStatus("connecting");
    setError("");
    // herdr 在 attach 时会完整重绘，先清空旧画面
    term.reset();

    ws.onopen = () => setStatus("open");
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
        return;
      }
      const msg = JSON.parse(String(ev.data)) as { t: "error"; message: string } | { t: "exit" };
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

    return () => {
      intentional = true;
      clearTimeout(hiddenTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      ws.close();
    };
  }, [props.paneId, reconnectTick]);

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
        case "deleteContentBackward":
          data = "\x7f";
          break;
        default:
          return; // 组字、粘贴（有专门的 paste 处理）、自动更正替换等不处理
      }
      e.preventDefault();
      if (data) input(data);
    };
    el.addEventListener("beforeinput", onBeforeInput, true);
    return () => el.removeEventListener("beforeinput", onBeforeInput, true);
  }, []);

  // 粘贴 / 拖入图片：上传后把路径粘贴进终端，agent 会把它识别为图片附件
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const handleFiles = async (files: File[]) => {
      for (const f of files) {
        const path = await propsRef.current.onImage?.(f);
        if (path) termRef.current?.paste(`${path} `);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length || !propsRef.current.onImage) return;
      e.preventDefault();
      e.stopPropagation();
      void handleFiles(files);
    };
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (!files.length || !propsRef.current.onImage) return;
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

  return (
    <div ref={wrap} className="ghostty-wrap">
      <div ref={container} className="ghostty" onClick={() => termRef.current?.focus()} />
      {status !== "open" && (
        <div className="term-overlay">
          {status === "connecting" && "连接中…"}
          {status === "closed" && "已断开，正在重连…"}
          {status === "error" && (
            <>
              <div>{error}</div>
              <button className="ghost small" onClick={() => setReconnectTick((n) => n + 1)}>
                重试
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
});
