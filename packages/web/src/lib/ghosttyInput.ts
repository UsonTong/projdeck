/**
 * ghostty-web 缺失的两项输入能力，补齐后接近原生 Ghostty：
 *
 * 1. 鼠标上报：ghostty-web 不会把点击 / 拖动 / 滚轮编码成终端鼠标协议发给程序。
 *    herdr 的 attach 客户端会开启鼠标追踪（1000/1002/1003 + SGR 1006），原生 Ghostty 把鼠标事件交给 herdr，
 *    再由 herdr 转给 Claude / Codex 或用来滚动历史。这里按当前开启的模式编码并发送。
 *    左键拖动始终是本地选择文字（见 attachMouse），点击才上报；右键留给右键菜单。
 *
 * 2. 文字输入：ghostty-web 用整个 contenteditable 容器收输入，组字不稳定，拼音预览和候选框也不在光标处。
 *    这里换成放在终端光标处的隐藏 textarea，见 attachTextInput。
 */
import type { Terminal } from "ghostty-web";

interface Metrics {
  width: number;
  height: number;
}

const metricsOf = (term: Terminal): Metrics | undefined =>
  (term as unknown as { renderer?: { getMetrics(): Metrics } }).renderer?.getMetrics();

const canvasOf = (term: Terminal): HTMLCanvasElement | undefined =>
  (term as unknown as { renderer?: { getCanvas(): HTMLCanvasElement } }).renderer?.getCanvas();

/** DEC 私有模式。 */
const mode = (term: Terminal, n: number) => {
  try {
    return term.getMode(n, false);
  } catch {
    return false;
  }
};

/** 编码一个鼠标事件。button：0 左 1 中 2 右 3 无按键；+32 移动；64/65 滚轮上/下。坐标从 1 开始。 */
export function encodeMouse(button: number, col: number, row: number, release: boolean, sgr: boolean): string {
  if (sgr) return `\x1b[<${button};${col};${row}${release ? "m" : "M"}`;
  // 旧式 X10 编码：坐标上限 223，松开统一为按键 3
  const b = release ? 3 : button;
  return `\x1b[M${String.fromCharCode(32 + b, 32 + Math.min(col, 223), 32 + Math.min(row, 223))}`;
}

const modifiers = (e: MouseEvent | WheelEvent) => (e.altKey || e.metaKey ? 8 : 0) | (e.ctrlKey ? 16 : 0);

export function attachMouse(term: Terminal, el: HTMLElement, send: (data: string) => void): () => void {
  const tracking = () => mode(term, 1000) || mode(term, 1002) || mode(term, 1003) || mode(term, 9);
  const sgr = () => mode(term, 1006);

  const cellAt = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasOf(term);
    const m = metricsOf(term);
    if (!canvas || !m) return null;
    const r = canvas.getBoundingClientRect();
    const col = Math.min(term.cols, Math.max(1, Math.floor((e.clientX - r.left) / m.width) + 1));
    const row = Math.min(term.rows, Math.max(1, Math.floor((e.clientY - r.top) / m.height) + 1));
    return { col, row };
  };

  let pressed: number | null = null;
  let last = "";

  /*
   * 左键：拖动始终在本地选择文字，只有「点击」（按下、松开之间没离开格子）才发给 herdr / 程序。
   * 原因：herdr 会按 pane 里的程序动态开关鼠标追踪，拖选时而是本地选区（主题色），时而是 herdr 的选区（蓝色），
   * 而 herdr 的选区要绕网络一圈才画出来，远程时明显跟不上鼠标。本地选区即时、颜色一致，松开即复制。
   * 双击同理在本地选词；第二下不再发给 herdr，否则 herdr 也会选一次词。
   */
  let left: { cell: { col: number; row: number }; mods: number; forward: boolean; moved: boolean } | null = null;
  let lastClick = { at: 0, key: "" };

  const onDown = (e: MouseEvent) => {
    if (e.button === 2) return; // 右键菜单
    const cell = cellAt(e);
    if (!cell) return;
    if (e.button === 0) {
      // 不拦截：ghostty-web 照常开始本地选择
      left = { cell, mods: modifiers(e), forward: tracking() && !e.shiftKey, moved: false };
      term.focus();
      return;
    }
    // 中键照常直接上报
    if (!tracking() || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    term.focus();
    pressed = e.button;
    last = `${cell.col},${cell.row}`;
    send(encodeMouse(e.button | modifiers(e), cell.col, cell.row, false, sgr()));
  };

  const onMove = (e: MouseEvent) => {
    if (left) {
      const cell = cellAt(e);
      if (cell && (cell.col !== left.cell.col || cell.row !== left.cell.row)) left.moved = true;
      return;
    }
    if (!tracking()) return;
    const dragging = pressed !== null && (mode(term, 1002) || mode(term, 1003));
    const hovering = pressed === null && mode(term, 1003) && el.contains(e.target as Node);
    if (!dragging && !hovering) return;
    const cell = cellAt(e);
    if (!cell) return;
    const key = `${cell.col},${cell.row}`;
    if (key === last) return; // 只在跨格子时上报，避免刷屏
    last = key;
    send(encodeMouse((pressed ?? 3) + 32 + modifiers(e), cell.col, cell.row, false, sgr()));
  };

  const onUp = (e: MouseEvent) => {
    if (left) {
      const click = left;
      left = null;
      if (click.moved) return; // 拖选：本地选区保留，ghostty-web 松开时复制
      const key = `${click.cell.col},${click.cell.row}`;
      const double = Date.now() - lastClick.at < 400 && lastClick.key === key;
      lastClick = { at: Date.now(), key };
      if (double) return; // 双击：ghostty-web 接着在本地选词
      // 单击：按下时 ghostty-web 起了一个单格选区，松开时会把这个字复制到剪贴板。
      // 它的 clearSelection() 认为单格不算选区、什么也不做，只能直接清状态
      const sm = (term as unknown as { selectionManager?: { selectionStart: unknown; selectionEnd: unknown; isSelecting: boolean } }).selectionManager;
      if (sm) {
        sm.selectionStart = sm.selectionEnd = null;
        sm.isSelecting = false;
      }
      if (click.forward) {
        const { col, row } = click.cell;
        send(encodeMouse(click.mods, col, row, false, sgr()));
        send(encodeMouse(click.mods, col, row, true, sgr()));
      }
      return;
    }
    if (pressed === null) return;
    const cell = cellAt(e) ?? { col: 1, row: 1 };
    send(encodeMouse(pressed | modifiers(e), cell.col, cell.row, true, sgr()));
    pressed = null;
  };

  // 滚轮：触控板一次会产生很多小 delta，累积到一定距离再发一格
  let wheelAcc = 0;
  const onWheel = (e: WheelEvent) => {
    if (!tracking() || e.shiftKey) return;
    const cell = cellAt(e);
    if (!cell) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? term.rows : 0;
    const lines = step ? Math.round(e.deltaY) * step : 0;
    if (step) wheelAcc = 0;
    else wheelAcc += e.deltaY;
    const px = (metricsOf(term)?.height ?? 20) * 1.5;
    let n = lines || Math.trunc(wheelAcc / px);
    if (!step) wheelAcc -= n * px;
    const button = n < 0 ? 64 : 65;
    for (n = Math.min(Math.abs(n), 10); n > 0; n--) send(encodeMouse(button + modifiers(e), cell.col, cell.row, false, sgr()));
  };

  // 手机：手指上下滑动转成滚轮事件（herdr 据此滚动历史或转给程序）
  let touchY: number | null = null;
  let touchAcc = 0;
  const onTouchStart = (e: TouchEvent) => {
    touchY = e.touches.length === 1 ? e.touches[0]!.clientY : null;
    touchAcc = 0;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (touchY === null || !tracking() || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    touchAcc += touchY - t.clientY;
    touchY = t.clientY;
    const h = metricsOf(term)?.height ?? 20;
    const cell = cellAt(t);
    if (!cell) return;
    e.preventDefault();
    while (Math.abs(touchAcc) >= h) {
      // 手指上移（acc > 0）= 内容向下滚 = 滚轮向下
      send(encodeMouse(touchAcc > 0 ? 65 : 64, cell.col, cell.row, false, sgr()));
      touchAcc -= Math.sign(touchAcc) * h;
    }
  };

  el.addEventListener("mousedown", onDown, true);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  el.addEventListener("wheel", onWheel, { capture: true, passive: false });
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  return () => {
    el.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    el.removeEventListener("wheel", onWheel, true);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
  };
}

/**
 * 文字输入：用一个专门的隐藏 textarea 接收键盘和输入法（与 xterm.js 相同的做法）。
 *
 * ghostty-web 把整个容器设为 contenteditable 来收输入。Chrome 在可编辑 div 里组字很不稳定：
 * 组字中途会反复重新开始（出现「nnihao」），输入法上屏时还会删掉周围的文字。textarea 里的组字是最成熟的路径。
 *
 * textarea 放在终端光标所在格子，输入法候选框就贴着光标弹出。textarea 本身透明，
 * 拼音预览由旁边的锚点元素以终端字体画出（带下划线，与 Ghostty 一致）。
 * 组字结果仍由 ghostty-web 在 compositionend 里发送，普通字符由 GhosttyTerminal 的 beforeinput 发送。
 */
export function attachTextInput(
  term: Terminal,
  container: HTMLElement,
  style: { fontFamily: string; fontSize: number; foreground: string; background: string },
): () => void {
  container.removeAttribute("contenteditable");
  // ghostty-web 自己的 textarea 只用于复制的兜底，不再接收焦点
  (term as unknown as { textarea?: HTMLTextAreaElement }).textarea?.setAttribute("tabindex", "-1");

  const input = document.createElement("textarea");
  for (const [k, v] of Object.entries({
    autocomplete: "off",
    autocorrect: "off",
    autocapitalize: "off",
    spellcheck: "false",
    wrap: "off",
    "aria-label": "终端输入",
  }))
    input.setAttribute(k, v);
  const font = { fontFamily: style.fontFamily, fontSize: `${style.fontSize}px`, whiteSpace: "pre" };
  Object.assign(input.style, {
    ...font,
    position: "absolute",
    width: "1px",
    padding: "0",
    margin: "0",
    border: "0",
    outline: "none",
    resize: "none",
    overflow: "hidden",
    opacity: "0",
    color: "transparent",
    background: "transparent",
    caretColor: "transparent",
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const preedit = document.createElement("span");
  preedit.setAttribute("aria-hidden", "true");
  Object.assign(preedit.style, {
    ...font,
    position: "absolute",
    zIndex: "5",
    display: "none",
    pointerEvents: "none",
    color: style.foreground,
    background: style.background,
    textDecoration: "underline",
    textUnderlineOffset: "3px",
  } satisfies Partial<CSSStyleDeclaration>);
  container.append(input, preedit);

  const place = () => {
    const m = metricsOf(term);
    const canvas = canvasOf(term);
    if (!m || !canvas) return;
    const { cursorX, cursorY } = term.buffer.active;
    const fontSize = (term as unknown as { renderer?: { fontSize: number } }).renderer?.fontSize;
    for (const el of [input, preedit]) {
      el.style.left = `${canvas.offsetLeft + cursorX * m.width}px`;
      el.style.top = `${canvas.offsetTop + cursorY * m.height}px`;
      el.style.height = `${m.height}px`;
      el.style.lineHeight = `${m.height}px`;
      if (fontSize) el.style.fontSize = `${fontSize}px`;
    }
  };

  // 焦点统一落在 textarea：ghostty-web 的 focus()、点画布、Tab 到容器都转过来
  const focus = () => input.focus({ preventScroll: true });
  const t = term as unknown as Pick<Terminal, "focus" | "blur" | "write">;
  const original = { focus: t.focus, blur: t.blur, write: t.write };
  t.focus = focus;
  t.blur = () => input.blur();
  // 跟着光标走。ghostty-web 的 onCursorMove 只在换行时触发，同一行内移动不通知，所以每次输出后（每帧最多一次）重新定位
  let frame = 0;
  t.write = (...args) => {
    original.write.apply(term, args);
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  };
  const onFocusIn = (e: FocusEvent) => {
    if (e.target !== input) focus();
  };

  let composing = false;
  /** 已提交的文字已经发给终端，textarea 里不留内容，下一次组字从空白开始。 */
  const reset = () => {
    if (composing) return;
    input.value = "";
    input.style.width = "1px";
  };
  const onCompositionStart = () => {
    composing = true;
    place();
  };
  const onCompositionUpdate = (e: CompositionEvent) => {
    preedit.textContent = e.data;
    preedit.style.display = e.data ? "" : "none";
    // textarea 与预览等宽，输入法看到的光标位置就在预览末尾
    input.style.width = `${Math.max(1, preedit.offsetWidth)}px`;
  };
  const onCompositionEnd = () => {
    composing = false;
    preedit.textContent = "";
    preedit.style.display = "none";
    setTimeout(reset, 0);
  };
  const onInput = (e: Event) => {
    if (!(e as InputEvent).isComposing) setTimeout(reset, 0);
  };

  const resizeSub = term.onResize(place);
  container.addEventListener("focusin", onFocusIn);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionupdate", onCompositionUpdate);
  input.addEventListener("compositionend", onCompositionEnd);
  input.addEventListener("input", onInput);
  input.addEventListener("blur", onCompositionEnd);
  place();
  if (document.activeElement === container) focus();
  return () => {
    resizeSub.dispose();
    cancelAnimationFrame(frame);
    Object.assign(t, original);
    container.removeEventListener("focusin", onFocusIn);
    input.remove();
    preedit.remove();
  };
}
