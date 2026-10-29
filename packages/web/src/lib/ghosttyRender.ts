/**
 * ghostty-web 渲染修正，让网页终端的观感接近原生 Ghostty。
 *
 * ghostty-web 只移植了 Ghostty 的 VT 解析器（WASM），画面由它自带的 Canvas2D 渲染器绘制，
 * 与原生 Ghostty（GPU 渲染 + 自绘制表符）有两处明显差距，这里在终端实例上替换对应方法修正：
 *
 * 1. 字符格子：原实现只量字母 M 的高度再加 2px，格子比字体行高矮，█ 等方块上下拼不严。
 *    改为用字体自身的行高（fontBoundingBox），并把格子宽高对齐到设备像素。
 * 2. 方块 / 制表符 / Powerline：原实现直接画字体字形，拼接处有缝。
 *    Ghostty 用像素精确的几何图形绘制这些字符（sprite font），这里照做。
 * 3. 按需绘制：原实现每一帧都完整走一遍绘制流程，见 renderOnDemand。
 */
import { CellFlags, type Terminal } from "ghostty-web";

interface Metrics {
  width: number;
  height: number;
  baseline: number;
}

interface Cell {
  codepoint: number;
  grapheme_len: number;
  width: number;
  flags: number;
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
}

interface Renderer {
  ctx: CanvasRenderingContext2D;
  fontSize: number;
  fontFamily: string;
  devicePixelRatio: number;
  metrics: Metrics;
  theme: { selectionForeground: string };
  measureFont(): Metrics;
  remeasureFont(): void;
  renderCellText(cell: Cell, col: number, row: number): void;
  isInSelection(col: number, row: number): boolean;
  render(buffer: unknown, force: boolean, viewportY: number, term: unknown, scrollbarOpacity?: number): void;
  cursorVisible: boolean;
  hoveredHyperlinkId: number;
  hoveredLinkRange: unknown;
}

// ---------------------------------------------------------------------------
// 制表符表：每个字符的四个方向（上、右、下、左）。0 无，1 细，2 粗，3 双线。
// ---------------------------------------------------------------------------

const BOX: Record<number, string> = {
  0x2500: "0101", 0x2501: "0202", 0x2502: "1010", 0x2503: "2020",
  0x250c: "0110", 0x250d: "0210", 0x250e: "0120", 0x250f: "0220",
  0x2510: "0011", 0x2511: "0012", 0x2512: "0021", 0x2513: "0022",
  0x2514: "1100", 0x2515: "1200", 0x2516: "2100", 0x2517: "2200",
  0x2518: "1001", 0x2519: "1002", 0x251a: "2001", 0x251b: "2002",
  0x251c: "1110", 0x251d: "1210", 0x251e: "2110", 0x251f: "1120",
  0x2520: "2120", 0x2521: "2210", 0x2522: "1220", 0x2523: "2220",
  0x2524: "1011", 0x2525: "1012", 0x2526: "2011", 0x2527: "1021",
  0x2528: "2021", 0x2529: "2012", 0x252a: "1022", 0x252b: "2022",
  0x252c: "0111", 0x252d: "0112", 0x252e: "0211", 0x252f: "0212",
  0x2530: "0121", 0x2531: "0122", 0x2532: "0221", 0x2533: "0222",
  0x2534: "1101", 0x2535: "1102", 0x2536: "1201", 0x2537: "1202",
  0x2538: "2101", 0x2539: "2102", 0x253a: "2201", 0x253b: "2202",
  0x253c: "1111", 0x253d: "1112", 0x253e: "1211", 0x253f: "1212",
  0x2540: "2111", 0x2541: "1121", 0x2542: "2121", 0x2543: "2112",
  0x2544: "2211", 0x2545: "1122", 0x2546: "1221", 0x2547: "2212",
  0x2548: "1222", 0x2549: "2122", 0x254a: "2221", 0x254b: "2222",
  0x2550: "0303", 0x2551: "3030",
  0x2552: "0310", 0x2553: "0130", 0x2554: "0330",
  0x2555: "0013", 0x2556: "0031", 0x2557: "0033",
  0x2558: "1300", 0x2559: "3100", 0x255a: "3300",
  0x255b: "1003", 0x255c: "3001", 0x255d: "3003",
  0x255e: "1310", 0x255f: "3130", 0x2560: "3330",
  0x2561: "1013", 0x2562: "3031", 0x2563: "3033",
  0x2564: "0313", 0x2565: "0131", 0x2566: "0333",
  0x2567: "1303", 0x2568: "3101", 0x2569: "3303",
  0x256a: "1313", 0x256b: "3131", 0x256c: "3333",
  0x2574: "0001", 0x2575: "1000", 0x2576: "0100", 0x2577: "0010",
  0x2578: "0002", 0x2579: "2000", 0x257a: "0200", 0x257b: "0020",
  0x257c: "0201", 0x257d: "1020", 0x257e: "0102", 0x257f: "2010",
};

/** 虚线：[方向, 粗细, 段数]。 */
const DASHED: Record<number, [dir: "h" | "v", weight: 1 | 2, segments: number]> = {
  0x2504: ["h", 1, 3], 0x2505: ["h", 2, 3], 0x2506: ["v", 1, 3], 0x2507: ["v", 2, 3],
  0x2508: ["h", 1, 4], 0x2509: ["h", 2, 4], 0x250a: ["v", 1, 4], 0x250b: ["v", 2, 4],
  0x254c: ["h", 1, 2], 0x254d: ["h", 2, 2], 0x254e: ["v", 1, 2], 0x254f: ["v", 2, 2],
};

const isSpecial = (cp: number) =>
  (cp >= 0x2500 && cp <= 0x259f) || (cp >= 0xe0b0 && cp <= 0xe0bf);

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 对齐到设备像素，保证线条清晰、相邻格子无缝。 */
const snap = (v: number, dpr: number) => Math.round(v * dpr) / dpr;

function drawBox(ctx: CanvasRenderingContext2D, r: Rect, arms: string, light: number) {
  const [up, right, down, left] = [...arms].map(Number) as [number, number, number, number];
  const heavy = light * 2;
  const gap = light; // 双线两条线之间的间距
  const cx = r.x + Math.floor(r.w / 2);
  const cy = r.y + Math.floor(r.h / 2);
  const thick = (w: number) => (w === 2 ? heavy : light);
  // 与当前方向垂直的那根线的半宽：让交叉处完全覆盖，不留缺口
  const half = (a: number, b: number) => Math.max(a === 3 || b === 3 ? gap + light / 2 : thick(Math.max(a, b)) / 2, light / 2);
  const hHalf = half(up, down);
  const vHalf = half(left, right);

  const hLine = (x0: number, x1: number, w: number) => {
    if (w === 3) {
      ctx.fillRect(x0, cy - gap - light / 2, x1 - x0, light);
      ctx.fillRect(x0, cy + gap - light / 2, x1 - x0, light);
    } else ctx.fillRect(x0, cy - thick(w) / 2, x1 - x0, thick(w));
  };
  const vLine = (y0: number, y1: number, w: number) => {
    if (w === 3) {
      ctx.fillRect(cx - gap - light / 2, y0, light, y1 - y0);
      ctx.fillRect(cx + gap - light / 2, y0, light, y1 - y0);
    } else ctx.fillRect(cx - thick(w) / 2, y0, thick(w), y1 - y0);
  };

  if (left) hLine(r.x, cx + (right ? 0 : hHalf), left);
  if (right) hLine(cx - (left ? 0 : hHalf), r.x + r.w, right);
  if (up) vLine(r.y, cy + (down ? 0 : vHalf), up);
  if (down) vLine(cy - (up ? 0 : vHalf), r.y + r.h, down);
}

function drawDashed(ctx: CanvasRenderingContext2D, r: Rect, [dir, weight, n]: [string, number, number], light: number) {
  const t = weight === 2 ? light * 2 : light;
  const len = dir === "h" ? r.w : r.h;
  const seg = len / n;
  const dash = seg * 0.6;
  for (let i = 0; i < n; i++) {
    const s = i * seg + (seg - dash) / 2;
    if (dir === "h") ctx.fillRect(r.x + s, r.y + Math.floor(r.h / 2) - t / 2, dash, t);
    else ctx.fillRect(r.x + Math.floor(r.w / 2) - t / 2, r.y + s, t, dash);
  }
}

/** ╭╮╯╰ 圆角。 */
function drawArc(ctx: CanvasRenderingContext2D, r: Rect, cp: number, light: number) {
  const cx = r.x + Math.floor(r.w / 2);
  const cy = r.y + Math.floor(r.h / 2);
  const rad = Math.min(r.w, r.h) / 2;
  // 竖线端点 vy 与横线端点 hx：╭ 下右，╮ 下左，╯ 上左，╰ 上右
  const vy = cp === 0x256d || cp === 0x256e ? r.y + r.h : r.y;
  const hx = cp === 0x256d || cp === 0x2570 ? r.x + r.w : r.x;
  const sy = Math.sign(vy - cy);
  const sx = Math.sign(hx - cx);
  ctx.save();
  ctx.lineWidth = light;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.beginPath();
  ctx.moveTo(cx, vy);
  ctx.lineTo(cx, cy + sy * rad);
  ctx.arcTo(cx, cy, cx + sx * rad, cy, rad);
  ctx.lineTo(hx, cy);
  ctx.stroke();
  ctx.restore();
}

function drawDiagonal(ctx: CanvasRenderingContext2D, r: Rect, cp: number, light: number) {
  ctx.save();
  ctx.lineWidth = light;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.beginPath();
  if (cp === 0x2571 || cp === 0x2573) {
    ctx.moveTo(r.x + r.w, r.y);
    ctx.lineTo(r.x, r.y + r.h);
  }
  if (cp === 0x2572 || cp === 0x2573) {
    ctx.moveTo(r.x, r.y);
    ctx.lineTo(r.x + r.w, r.y + r.h);
  }
  ctx.stroke();
  ctx.restore();
}

/** U+2580–259F 方块元素。阴影字符按 Ghostty 的做法画成半透明实色。 */
function drawBlock(ctx: CanvasRenderingContext2D, r: Rect, cp: number, dpr: number): boolean {
  const { x, y, w, h } = r;
  const fill = (fx: number, fy: number, fw: number, fh: number) =>
    ctx.fillRect(snap(x + fx * w, dpr), snap(y + fy * h, dpr), snap(fw * w, dpr), snap(fh * h, dpr));
  const quad = (q: string) => {
    if (q.includes("a")) fill(0, 0, 0.5, 0.5); // 左上
    if (q.includes("b")) fill(0.5, 0, 0.5, 0.5); // 右上
    if (q.includes("c")) fill(0, 0.5, 0.5, 0.5); // 左下
    if (q.includes("d")) fill(0.5, 0.5, 0.5, 0.5); // 右下
  };
  if (cp === 0x2580) fill(0, 0, 1, 0.5);
  else if (cp >= 0x2581 && cp <= 0x2588) {
    const k = (cp - 0x2580) / 8; // ▁▂▃▄▅▆▇█：从下往上 k/8
    fill(0, 1 - k, 1, k);
  } else if (cp >= 0x2589 && cp <= 0x258f) {
    const k = (0x2590 - cp) / 8; // ▉▊▋▌▍▎▏：从左往右 k/8
    fill(0, 0, k, 1);
  } else if (cp === 0x2590) fill(0.5, 0, 0.5, 1);
  else if (cp >= 0x2591 && cp <= 0x2593) {
    ctx.save();
    ctx.globalAlpha *= (cp - 0x2590) * 0.25; // ░ 25%  ▒ 50%  ▓ 75%
    fill(0, 0, 1, 1);
    ctx.restore();
  } else if (cp === 0x2594) fill(0, 0, 1, 1 / 8);
  else if (cp === 0x2595) fill(7 / 8, 0, 1 / 8, 1);
  else {
    const quads: Record<number, string> = {
      0x2596: "c", 0x2597: "d", 0x2598: "a", 0x2599: "acd", 0x259a: "ad",
      0x259b: "abc", 0x259c: "abd", 0x259d: "b", 0x259e: "bc", 0x259f: "bcd",
    };
    if (!quads[cp]) return false;
    quad(quads[cp]);
  }
  return true;
}

/** Powerline 箭头与半圆（U+E0B0–E0BF），填满整个格子，与相邻背景无缝衔接。 */
function drawPowerline(ctx: CanvasRenderingContext2D, r: Rect, cp: number, light: number): boolean {
  const { x, y, w, h } = r;
  const cy = y + h / 2;
  const L = x;
  const R = x + w;
  const T = y;
  const B = y + h;
  const poly = (pts: [number, number][], filled: boolean) => {
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
    if (filled) {
      ctx.closePath();
      ctx.fill();
    } else ctx.stroke();
  };
  const halfDisc = (centerX: number, from: number, to: number, filled: boolean) => {
    const inset = filled ? 0 : light / 2;
    ctx.beginPath();
    ctx.ellipse(centerX, cy, w - inset, h / 2 - inset, 0, from, to);
    if (filled) ctx.fill();
    else ctx.stroke();
  };

  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = light;
  const up = -Math.PI / 2;
  const down = Math.PI / 2;
  switch (cp) {
    case 0xe0b0: poly([[L, T], [R, cy], [L, B]], true); break; // 实心右箭头
    case 0xe0b1: poly([[L, T], [R, cy], [L, B]], false); break; // 空心右箭头
    case 0xe0b2: poly([[R, T], [L, cy], [R, B]], true); break; // 实心左箭头
    case 0xe0b3: poly([[R, T], [L, cy], [R, B]], false); break; // 空心左箭头
    case 0xe0b4: halfDisc(L, up, down, true); break; // 实心右半圆
    case 0xe0b5: halfDisc(L, up, down, false); break; // 空心右半圆
    case 0xe0b6: halfDisc(R, down, up + Math.PI * 2, true); break; // 实心左半圆
    case 0xe0b7: halfDisc(R, down, up + Math.PI * 2, false); break; // 空心左半圆
    case 0xe0b8: poly([[L, T], [R, B], [L, B]], true); break; // 左下三角
    case 0xe0ba: poly([[R, T], [R, B], [L, B]], true); break; // 右下三角
    case 0xe0bc: poly([[L, T], [R, T], [L, B]], true); break; // 左上三角
    case 0xe0be: poly([[L, T], [R, T], [R, B]], true); break; // 右上三角
    default:
      ctx.restore();
      return false;
  }
  ctx.restore();
  return true;
}

/** 按与原实现相同的规则（选区、反色、暗淡）设置前景色。 */
function applyForeground(r: Renderer, cell: Cell, col: number, row: number) {
  const ctx = r.ctx;
  if (r.isInSelection(col, row)) ctx.fillStyle = r.theme.selectionForeground;
  else if (cell.flags & CellFlags.INVERSE) ctx.fillStyle = `rgb(${cell.bg_r}, ${cell.bg_g}, ${cell.bg_b})`;
  else ctx.fillStyle = `rgb(${cell.fg_r}, ${cell.fg_g}, ${cell.fg_b})`;
}

function drawSpecial(r: Renderer, cell: Cell, col: number, row: number): boolean {
  const cp = cell.codepoint;
  if (cell.grapheme_len > 0 || !isSpecial(cp) || cell.flags & CellFlags.INVISIBLE) return false;
  const { width, height } = r.metrics;
  const dpr = r.devicePixelRatio;
  const rect: Rect = { x: col * width, y: row * height, w: width * Math.max(1, cell.width), h: height };
  // 细线粗细跟随字号，至少 1 个设备像素
  const light = Math.max(1 / dpr, snap(r.fontSize / 14, dpr));
  const ctx = r.ctx;

  ctx.save();
  applyForeground(r, cell, col, row);
  if (cell.flags & CellFlags.FAINT) ctx.globalAlpha = 0.5;
  let done = true;
  if (BOX[cp]) drawBox(ctx, rect, BOX[cp]!, light);
  else if (DASHED[cp]) drawDashed(ctx, rect, DASHED[cp]!, light);
  else if (cp >= 0x256d && cp <= 0x2570) drawArc(ctx, rect, cp, light);
  else if (cp >= 0x2571 && cp <= 0x2573) drawDiagonal(ctx, rect, cp, light);
  else if (cp >= 0x2580 && cp <= 0x259f) done = drawBlock(ctx, rect, cp, dpr);
  else done = drawPowerline(ctx, rect, cp, light);
  ctx.restore();
  return done;
}

/**
 * 字符格子按字体自身的行高计算（与原生终端一致），宽高对齐到设备像素。
 * 对齐很重要：ghostty-web 每帧比较 canvas 尺寸与 cols × 宽 × dpr，非整数会导致每帧重建画布。
 */
function measureFont(this: Renderer): Metrics {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${this.fontSize}px ${this.fontFamily}`;
  const m = ctx.measureText("M");
  const dpr = this.devicePixelRatio;
  const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || this.fontSize * 0.8;
  const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || this.fontSize * 0.2;
  const width = Math.ceil(m.width * dpr) / dpr;
  const height = Math.ceil((ascent + descent) * dpr) / dpr;
  const baseline = Math.round(ascent * dpr) / dpr;
  return { width, height, baseline };
}

/** 在 term.open() 之后调用。 */
/**
 * 只在画面可能变化时才绘制。
 * ghostty-web 每一帧都调用 render：逐行向 WASM 询问是否有变化，开着光标闪烁时还每帧重画光标所在的整行。
 * 终端什么都没变时也要占约 10% 的 CPU，侧栏、按钮动画等其他部分因此掉帧。
 * 画面只会因这些而变：新输出 / 重置 / 改尺寸、选区、滚动（含滚动条淡出）、链接悬停、光标闪烁、字号。
 */
function renderOnDemand(term: Terminal, r: Renderer): void {
  type Fn = (...args: unknown[]) => unknown;
  const t = term as unknown as Record<"write" | "reset" | "resize" | "clear", Fn> & {
    selectionManager?: { requestRender(): void; getDirtySelectionRows(): Set<number> };
  };
  let dirty = true;
  for (const name of ["write", "reset", "resize", "clear"] as const) {
    const fn = t[name];
    t[name] = function (this: unknown, ...args: unknown[]) {
      dirty = true;
      return fn.apply(this, args);
    };
  }
  const selection = t.selectionManager;
  // 选区拖动时 ghostty-web 会调用这个空方法（原来靠每帧重画），这里用来标记需要重画
  if (selection) selection.requestRender = () => void (dirty = true);

  const render = r.render.bind(r);
  let last: unknown[] = [];
  r.render = (buffer, force, viewportY, terminal, scrollbarOpacity) => {
    const state = [viewportY, scrollbarOpacity, r.cursorVisible, r.hoveredHyperlinkId, r.hoveredLinkRange, r.metrics.width, r.metrics.height];
    const changed = state.some((v, i) => v !== last[i]);
    if (!force && !dirty && !changed && !selection?.getDirtySelectionRows().size) return;
    dirty = false;
    last = state;
    render(buffer, force, viewportY, terminal, scrollbarOpacity);
  };
}

export function patchRenderer(term: Terminal): void {
  const r = (term as unknown as { renderer: Renderer }).renderer;
  r.measureFont = measureFont;
  r.remeasureFont();
  const original = r.renderCellText.bind(r);
  // 中文等宽字符保持原实现：与原生 Ghostty 一样按正常字号、从格子左侧画，不放大
  r.renderCellText = function (cell, col, row) {
    if (!drawSpecial(r, cell, col, row)) original(cell, col, row);
  };
  renderOnDemand(term, r);
}
