/**
 * 手机上的终端手势（ghostty-web 只处理鼠标）：
 * - 单指上下滑：滚动（转成滚轮事件发给 herdr，由它滚动历史或交给程序）；
 * - 长按：选中手指下的一段文字（到空格为止，路径、网址能整段选中），不松手继续拖可以扩大选区；
 *   松手后两端出现把手，按住把手拖动调整；
 * - 双指捏合：调字号。
 * 轻点不处理，浏览器照常补发鼠标事件（点击上报给程序、弹出软键盘）。
 */
import type { Terminal } from "ghostty-web";
import { canvasOf, encodeMouse, metricsOf, mode } from "./ghosttyInput";

const LONG_PRESS_MS = 450;
/** 手指移动超过这个距离就不算长按，而是滑动。 */
const SLOP_PX = 8;
/** 捏合距离变化这么多调一档字号。 */
const PINCH_STEP = 1.12;
/** 按在把手附近多远以内算拖把手。 */
const HANDLE_HIT_PX = 28;

interface Pos {
  col: number;
  absoluteRow: number;
}

interface Cell {
  codepoint: number;
  width: number;
}

/** ghostty-web SelectionManager 的内部成员（选区直接写在这里，渲染器从这里读）。 */
interface SelectionInternals {
  selectionStart: Pos | null;
  selectionEnd: Pos | null;
  isSelecting: boolean;
  wasmTerm: { getLine(row: number): Cell[] | null };
  viewportRowToAbsolute(row: number): number;
  absoluteRowToViewport(row: number): number;
  markCurrentSelectionDirty(): void;
  requestRender(): void;
  selectionChangedEmitter: { fire(): void };
}

/** 选区的位置（CSS 像素，相对终端外层容器的左上角），用来摆放把手和工具条。 */
export interface SelectionGeometry {
  /** 起点格子的左下角。 */
  start: { x: number; y: number };
  /** 终点格子的右下角。 */
  end: { x: number; y: number };
  top: number;
  bottom: number;
}

export interface TouchCallbacks {
  /** 长按选好了（或调整完把手）：显示把手和复制工具条。geometry 为空表示按在空白处，没有选中文字。 */
  onSelect(geometry: SelectionGeometry | null, at: { x: number; y: number }): void;
  /** 开始一个新手势（滚动、点击、拖把手），隐藏工具条。 */
  onDismiss(): void;
  /** 捏合调字号。 */
  onFontSize(delta: 1 | -1): void;
}

const before = (a: Pos, b: Pos) => a.absoluteRow < b.absoluteRow || (a.absoluteRow === b.absoluteRow && a.col < b.col);

/** 选区两端去掉的标点：选中的路径、网址常被括号、引号、句末标点包着。 */
const LEADING = /[([{<'"`「『（【《]/;
const TRAILING = /[)\]}>'"`,.;:!?」』）】》，。；：！？、]/;

/**
 * 长按处的「一段」：连续的非空白字符（宽字符的占位格算在内），再去掉两端的标点。
 * 比 ghostty-web 双击选词（只认字母数字）更适合手机：路径、网址、中文句子都能一次选中。
 */
function segmentAt(line: Cell[], col: number): [number, number] | null {
  const solid = (i: number) => {
    const c = line[i];
    if (!c) return false;
    if (c.codepoint === 0) return i > 0 && line[i - 1]?.width === 2;
    return !/\s/.test(String.fromCodePoint(c.codepoint));
  };
  if (!solid(col)) return null;
  let a = col;
  let b = col;
  while (a > 0 && solid(a - 1)) a--;
  while (b < line.length - 1 && solid(b + 1)) b++;
  const ch = (i: number) => (line[i]?.codepoint ? String.fromCodePoint(line[i]!.codepoint) : "");
  while (a < col && LEADING.test(ch(a))) a++;
  while (b > col && TRAILING.test(ch(b))) b--;
  return [a, b];
}

export function attachTouch(
  term: Terminal,
  el: HTMLElement,
  send: (data: string) => void,
  cb: TouchCallbacks,
): { dispose(): void; geometry(): SelectionGeometry | null } {
  const sm = () => (term as unknown as { selectionManager?: SelectionInternals }).selectionManager;
  const tracking = () => mode(term, 1000) || mode(term, 1002) || mode(term, 1003) || mode(term, 9);

  const cellAt = (x: number, y: number) => {
    const canvas = canvasOf(term);
    const m = metricsOf(term);
    if (!canvas || !m) return null;
    const r = canvas.getBoundingClientRect();
    return {
      col: Math.min(term.cols - 1, Math.max(0, Math.floor((x - r.left) / m.width))),
      row: Math.min(term.rows - 1, Math.max(0, Math.floor((y - r.top) / m.height))),
    };
  };

  /** 当前选区（已按先后排好）在容器里的位置；不在屏幕上时为 null。 */
  const geometry = (): SelectionGeometry | null => {
    const s = sm();
    const canvas = canvasOf(term);
    const m = metricsOf(term);
    if (!s?.selectionStart || !s.selectionEnd || !canvas || !m || !term.hasSelection()) return null;
    let [a, b] = [s.selectionStart, s.selectionEnd];
    if (before(b, a)) [a, b] = [b, a];
    const ra = s.absoluteRowToViewport(a.absoluteRow);
    const rb = s.absoluteRowToViewport(b.absoluteRow);
    if (rb < 0 || ra >= term.rows) return null;
    const c = canvas.getBoundingClientRect();
    const e = (el.parentElement ?? el).getBoundingClientRect();
    const ox = c.left - e.left;
    const oy = c.top - e.top;
    return {
      start: { x: ox + a.col * m.width, y: oy + (ra + 1) * m.height },
      end: { x: ox + (b.col + 1) * m.width, y: oy + (rb + 1) * m.height },
      top: oy + Math.max(0, ra) * m.height,
      bottom: oy + Math.min(term.rows, rb + 1) * m.height,
    };
  };

  const setSelection = (a: Pos, b: Pos) => {
    const s = sm();
    if (!s) return;
    s.markCurrentSelectionDirty();
    s.selectionStart = a;
    s.selectionEnd = b;
    s.isSelecting = false;
    s.requestRender();
    s.selectionChangedEmitter.fire();
  };

  /**
   * 拖动选区时固定不动的一端。长按选中一段后继续拖：手指在这段之前就以段尾为界，之后就以段首为界；
   * 拖把手时两端都是另一个把手。
   */
  let anchor: { low: Pos; high: Pos } | null = null;
  type Gesture = "pending" | "scroll" | "select" | "pinch" | "done";
  let gesture: Gesture = "done";
  let start = { x: 0, y: 0 };
  let lastY = 0;
  let scrollAcc = 0;
  let pinchBase = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastTouchAt = 0;

  const local = (x: number, y: number) => {
    const r = (el.parentElement ?? el).getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  };

  const beginSelect = (x: number, y: number) => {
    const s = sm();
    const cell = cellAt(x, y);
    if (!s || !cell) return;
    gesture = "select";
    navigator.vibrate?.(10);
    const line = s.wasmTerm.getLine(cell.row);
    const seg = line ? segmentAt(line, cell.col) : null;
    const absoluteRow = s.viewportRowToAbsolute(cell.row);
    if (!seg) {
      // 按在空白处：不选，只给粘贴等操作
      anchor = null;
      term.clearSelection();
      return;
    }
    anchor = { low: { col: seg[0], absoluteRow }, high: { col: seg[1], absoluteRow } };
    setSelection(anchor.low, anchor.high);
  };

  const extendTo = (x: number, y: number) => {
    const s = sm();
    const cell = cellAt(x, y);
    if (!s || !cell || !anchor) return;
    const p = { col: cell.col, absoluteRow: s.viewportRowToAbsolute(cell.row) };
    if (before(p, anchor.low)) setSelection(p, anchor.high);
    else if (before(anchor.high, p)) setSelection(anchor.low, p);
    else setSelection(anchor.low, anchor.high);
  };

  /** 按在把手上：以另一端为界拖动。 */
  const grabHandle = (x: number, y: number): boolean => {
    const g = geometry();
    const s = sm();
    if (!g || !s?.selectionStart || !s.selectionEnd) return false;
    const p = local(x, y);
    const near = (h: { x: number; y: number }) => Math.hypot(p.x - h.x, p.y - h.y) < HANDLE_HIT_PX;
    let [a, b] = [s.selectionStart, s.selectionEnd];
    if (before(b, a)) [a, b] = [b, a];
    // 两个把手都在附近时取近的
    const dStart = Math.hypot(p.x - g.start.x, p.y - g.start.y);
    const dEnd = Math.hypot(p.x - g.end.x, p.y - g.end.y);
    if (near(g.end) && dEnd <= dStart) anchor = { low: a, high: a };
    else if (near(g.start)) anchor = { low: b, high: b };
    else return false;
    gesture = "select";
    return true;
  };

  const onTouchStart = (e: TouchEvent) => {
    lastTouchAt = Date.now();
    clearTimeout(timer);
    if (e.touches.length === 2) {
      gesture = "pinch";
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      pinchBase = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      cb.onDismiss();
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0]!;
    start = { x: t.clientX, y: t.clientY };
    lastY = t.clientY;
    scrollAcc = 0;
    cb.onDismiss();
    if (grabHandle(t.clientX, t.clientY)) return;
    gesture = "pending";
    timer = setTimeout(() => gesture === "pending" && beginSelect(start.x, start.y), LONG_PRESS_MS);
  };

  const onTouchMove = (e: TouchEvent) => {
    if (gesture === "pinch") {
      e.preventDefault();
      if (e.touches.length !== 2) return;
      const [a, b] = [e.touches[0]!, e.touches[1]!];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (d > pinchBase * PINCH_STEP) {
        cb.onFontSize(1);
        pinchBase = d;
      } else if (d < pinchBase / PINCH_STEP) {
        cb.onFontSize(-1);
        pinchBase = d;
      }
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0]!;
    if (gesture === "select") {
      e.preventDefault();
      extendTo(t.clientX, t.clientY);
      return;
    }
    if (gesture === "pending") {
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) < SLOP_PX) return;
      clearTimeout(timer);
      gesture = "scroll";
      if (term.hasSelection()) term.clearSelection();
    }
    if (gesture !== "scroll") return;
    e.preventDefault();
    if (!tracking()) return;
    // 手指上移（acc > 0）= 内容向下滚 = 滚轮向下
    scrollAcc += lastY - t.clientY;
    lastY = t.clientY;
    const h = metricsOf(term)?.height ?? 20;
    const cell = cellAt(t.clientX, t.clientY);
    if (!cell) return;
    const sgr = mode(term, 1006);
    while (Math.abs(scrollAcc) >= h) {
      send(encodeMouse(scrollAcc > 0 ? 65 : 64, cell.col + 1, cell.row + 1, false, sgr));
      scrollAcc -= Math.sign(scrollAcc) * h;
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    clearTimeout(timer);
    if (e.touches.length > 0) return; // 捏合时先抬起一根手指
    if (gesture === "select") {
      // 不让浏览器补发鼠标事件：ghostty-web 收到 mousedown 会清掉刚选好的选区
      if (e.cancelable) e.preventDefault();
      cb.onSelect(geometry(), local(start.x, start.y));
    } else if (gesture === "pinch" || gesture === "scroll") {
      if (e.cancelable) e.preventDefault();
    } else if (gesture === "pending" && term.hasSelection()) {
      // 点了别处：取消选区
      term.clearSelection();
    }
    gesture = "done";
  };

  /** 长按时浏览器会弹系统菜单（安卓的 contextmenu），手指操作时一律拦掉。 */
  const onContextMenu = (e: MouseEvent) => {
    if (Date.now() - lastTouchAt > 1500) return;
    e.preventDefault();
    e.stopPropagation();
  };

  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  el.addEventListener("touchend", onTouchEnd, { passive: false });
  el.addEventListener("touchcancel", onTouchEnd, { passive: false });
  el.addEventListener("contextmenu", onContextMenu, true);
  const dispose = () => {
    clearTimeout(timer);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchEnd);
    el.removeEventListener("contextmenu", onContextMenu, true);
  };
  return { dispose, geometry };
}
