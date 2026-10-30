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
 * 4. 逐行绘制提速：原实现每个格子都重设字体、拼颜色字符串、调用 fillText，见 renderLine。
 * 5. 读取屏幕内容：原实现每读一行都把整屏从 WASM 复制解析一遍，见 cacheViewport。
 */
import { CellFlags, type Terminal } from "ghostty-web";

interface Metrics {
  width: number;
  height: number;
  baseline: number;
}

interface Cell {
  codepoint: number;
  hyperlink_id: number;
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

interface LinkRange {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface Renderer {
  ctx: CanvasRenderingContext2D;
  renderLine(line: Cell[], row: number, cols: number): void;
  currentBuffer: { getGraphemeString?(row: number, col: number): string; getLine?(row: number): Cell[] | null } | null;
  currentSelectionCoords: unknown;
  fontSize: number;
  fontFamily: string;
  devicePixelRatio: number;
  metrics: Metrics;
  theme: { background: string; selectionBackground: string; selectionForeground: string; cursor: string; cursorAccent: string };
  cursorStyle: "block" | "underline" | "bar";
  renderCursor(x: number, y: number): void;
  measureFont(): Metrics;
  remeasureFont(): void;
  isInSelection(col: number, row: number): boolean;
  render(buffer: unknown, force: boolean, viewportY: number, term: unknown, scrollbarOpacity?: number): void;
  cursorVisible: boolean;
  hoveredHyperlinkId: number;
  hoveredLinkRange: LinkRange | null;
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

// ---------------------------------------------------------------------------
// 逐行绘制
// ---------------------------------------------------------------------------

const rgbCache = new Map<number, string>();
const rgb = (key: number) => {
  let css = rgbCache.get(key);
  if (!css) rgbCache.set(key, (css = `rgb(${key >> 16}, ${(key >> 8) & 255}, ${key & 255})`));
  return css;
};
const SELECTED = 1 << 24; // 颜色键里表示「选区颜色」

/** 每种字体的字宽，用于把整段 ASCII 用 letterSpacing 对齐到格子上。 */
const advances = new Map<string, number>();
let measurer: CanvasRenderingContext2D | null = null;
const advanceOf = (font: string) => {
  let w = advances.get(font);
  if (w === undefined) {
    // 单独的画布：绘制用的画布上带着上一种字体的 letterSpacing，measureText 会把它算进去
    measurer ??= document.createElement("canvas").getContext("2d")!;
    measurer.font = font;
    advances.set(font, (w = measurer.measureText("M").width));
  }
  return w;
};
const canSpace = typeof CanvasRenderingContext2D !== "undefined" && "letterSpacing" in CanvasRenderingContext2D.prototype;

/**
 * 替换 ghostty-web 的 renderLine，画面结果相同：
 * - 背景：相邻同色格子合并成一次 fillRect；
 * - 文字：空白格子跳过，连续 ASCII 合成一段绘制；制表符 / 方块 / Powerline 仍按几何图形绘制。
 */
function renderLine(r: Renderer, line: Cell[], row: number, cols: number): void {
  const ctx = r.ctx;
  const { width, height } = r.metrics;
  const y = row * height;
  const selection = r.currentSelectionCoords !== null;
  const selected = (col: number) => selection && r.isInSelection(col, row);

  ctx.fillStyle = r.theme.background;
  ctx.fillRect(0, y, cols * width, height);

  // 背景：-1 表示默认背景（不画）
  let runStart = 0;
  let runKey = -1;
  const flush = (end: number) => {
    if (runKey === -1 || end <= runStart) return;
    ctx.fillStyle = runKey === SELECTED ? r.theme.selectionBackground : rgb(runKey);
    ctx.fillRect(runStart * width, y, (end - runStart) * width, height);
  };
  for (let c = 0; c < line.length; c++) {
    const cell = line[c]!;
    if (cell.width === 0) continue; // 宽字符的第二格，背景随第一格
    let key: number;
    if (selected(c)) key = SELECTED;
    else {
      const inv = cell.flags & CellFlags.INVERSE;
      const rr = inv ? cell.fg_r : cell.bg_r;
      const gg = inv ? cell.fg_g : cell.bg_g;
      const bb = inv ? cell.fg_b : cell.bg_b;
      key = rr === 0 && gg === 0 && bb === 0 ? -1 : (rr << 16) | (gg << 8) | bb;
    }
    if (key !== runKey) {
      flush(c);
      runStart = c;
      runKey = key;
    }
  }
  flush(line.length);

  // 文字。连续的同样式 ASCII 合成一段，一次 fillText 画完，letterSpacing 补齐字宽与格子宽的差，
  // 每个字仍落在自己的格子上。逐格调用 fillText 时满屏一帧要几十毫秒，按段画不到 1 毫秒。
  // 中文、图标、表情等可能来自其他字体，宽度不一定与主字体相同，逐个画在各自格子的起点。
  const link = r.hoveredLinkRange;
  let font = "";
  let fill = "";
  const setFont = (style: number) => {
    const f = `${style & CellFlags.ITALIC ? "italic " : ""}${style & CellFlags.BOLD ? "bold " : ""}${r.fontSize}px ${r.fontFamily}`;
    if (f !== font) {
      ctx.font = font = f;
      if (canSpace) ctx.letterSpacing = `${width - advanceOf(f)}px`;
    }
  };
  const setFill = (color: string) => {
    if (color !== fill) ctx.fillStyle = fill = color;
  };
  const baseline = y + r.metrics.baseline;
  let run = "";
  let runX = 0;
  let textKey = "";
  let runStyle = 0;
  let runColor = "";
  const flushRun = () => {
    if (!run) return;
    setFont(runStyle);
    setFill(runColor);
    if (runStyle & CellFlags.FAINT) ctx.globalAlpha = 0.5;
    ctx.fillText(run.trimEnd(), runX, baseline);
    if (runStyle & CellFlags.FAINT) ctx.globalAlpha = 1;
    run = "";
  };

  for (let c = 0; c < line.length; c++) {
    const cell = line[c]!;
    if (cell.width === 0) continue;
    const cp = cell.codepoint;
    const blank = cell.grapheme_len === 0 && (cp === 0 || cp === 32);
    const decorated = cell.flags & (CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH) || (cell.hyperlink_id > 0 && cell.hyperlink_id === r.hoveredHyperlinkId) || link;
    if (blank || cell.flags & CellFlags.INVISIBLE) {
      // 空格不打断当前段（没有字形，颜色无所谓）
      if (run) run += " ";
      if (decorated && !(cell.flags & CellFlags.INVISIBLE)) drawDecorations(r, cell, c, row, fill || rgb((cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b));
      continue;
    }
    const sel = selected(c);
    const inv = cell.flags & CellFlags.INVERSE;
    const color = sel ? r.theme.selectionForeground : rgb(inv ? (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b : (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b);
    const style = cell.flags & (CellFlags.BOLD | CellFlags.ITALIC | CellFlags.FAINT);

    if (canSpace && cell.grapheme_len === 0 && cp > 32 && cp < 127 && cell.width === 1) {
      const key = `${style}|${color}`;
      if (run && key !== textKey) flushRun();
      if (!run) {
        runX = c * width;
        textKey = key;
        runStyle = style;
        runColor = color;
      }
      run += String.fromCharCode(cp);
    } else {
      flushRun();
      if (!drawSpecial(r, cell, c, row)) {
        setFont(style);
        setFill(color);
        if (style & CellFlags.FAINT) ctx.globalAlpha = 0.5;
        const text = cell.grapheme_len > 0 ? (r.currentBuffer?.getGraphemeString?.(row, c) ?? String.fromCodePoint(cp)) : String.fromCodePoint(cp);
        ctx.fillText(text, c * width, baseline);
        if (style & CellFlags.FAINT) ctx.globalAlpha = 1;
        // drawSpecial 用 save/restore 改过画笔，下次重新设置
      } else font = fill = "";
    }
    if (decorated) drawDecorations(r, cell, c, row, color);
  }
  flushRun();
  // 其他绘制（光标、滚动条）不使用字距
  if (canSpace) ctx.letterSpacing = "0px";
}

/**
 * 光标。ghostty-web 的方块光标只是一个色块，盖住了下面的字；在中文等宽字符上也只有一格宽，挡住半个字。
 * 这里与原生 Ghostty 一致：宽字符上光标占两格，方块光标里用光标文字色（cursor-text）把字重新画出来。
 */
function renderCursor(r: Renderer, x: number, y: number): void {
  const ctx = r.ctx;
  const { width, height, baseline } = r.metrics;
  const cell = r.currentBuffer?.getLine?.(y)?.[x];
  const w = width * (cell?.width === 2 ? 2 : 1);
  const left = x * width;
  const top = y * height;
  ctx.fillStyle = r.theme.cursor;
  if (r.cursorStyle === "underline") {
    const h = Math.max(2, Math.floor(height * 0.15));
    ctx.fillRect(left, top + height - h, w, h);
    return;
  }
  if (r.cursorStyle === "bar") {
    ctx.fillRect(left, top, Math.max(2, Math.floor(width * 0.15)), height);
    return;
  }
  ctx.fillRect(left, top, w, height);
  if (!cell || cell.flags & CellFlags.INVISIBLE || isSpecial(cell.codepoint)) return;
  const cp = cell.codepoint;
  if (cell.grapheme_len === 0 && (cp === 0 || cp === 32)) return;
  const text = cell.grapheme_len > 0 ? (r.currentBuffer?.getGraphemeString?.(y, x) ?? String.fromCodePoint(cp)) : String.fromCodePoint(cp);
  ctx.font = `${cell.flags & CellFlags.ITALIC ? "italic " : ""}${cell.flags & CellFlags.BOLD ? "bold " : ""}${r.fontSize}px ${r.fontFamily}`;
  if (canSpace) ctx.letterSpacing = "0px";
  ctx.fillStyle = r.theme.cursorAccent;
  ctx.fillText(text, left, top + baseline);
}

/** 下划线、删除线、链接悬停下划线（与 ghostty-web 原实现一致）。 */
function drawDecorations(r: Renderer, cell: Cell, col: number, row: number, color: string): void {
  const ctx = r.ctx;
  const { width, height, baseline } = r.metrics;
  const x = col * width;
  const y = row * height;
  const w = width * cell.width;
  const line = (yy: number, style: string) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
    ctx.stroke();
  };
  if (cell.flags & CellFlags.UNDERLINE) line(y + baseline + 2, color);
  if (cell.flags & CellFlags.STRIKETHROUGH) line(y + height / 2, color);
  if (cell.hyperlink_id > 0 && cell.hyperlink_id === r.hoveredHyperlinkId) line(y + baseline + 2, "#4A90E2");
  const m = r.hoveredLinkRange;
  if (
    m &&
    ((row === m.startY && col >= m.startX && (row < m.endY || col <= m.endX)) ||
      (row > m.startY && row < m.endY) ||
      (row === m.endY && col <= m.endX && (row > m.startY || col >= m.startX)))
  )
    line(y + baseline + 2, "#4A90E2");
}

/**
 * ghostty-web 的 getLine(row) 每次都把整屏格子从 WASM 复制并解析成对象，再取其中一行；
 * 绘制一帧要读每一行，于是整屏被解析「行数」遍（2560×1440 全屏一帧约 150 万个格子）。
 * 改为整屏读一次缓存起来，有新输出或改尺寸时作废。
 * reset() 会新建 WASM 终端实例，所以补丁打在原型上。返回的格子是缓存里的对象，下次输出后会被复用，调用方不能长期持有
 * （ghostty-web 内部只在当次使用：绘制、取选区文字；链接检测在每次输出时清缓存）。
 */
function cacheViewport(term: Terminal): void {
  interface Wasm {
    _rows: number;
    _cols: number;
    update(): unknown;
    getViewport(): Cell[];
    write(...args: unknown[]): unknown;
    resize(...args: unknown[]): unknown;
    getLine(row: number): Cell[] | null;
    __viewport?: Cell[] | null;
  }
  const wasm = (term as unknown as { wasmTerm?: Wasm }).wasmTerm;
  if (!wasm) return;
  const proto = Object.getPrototypeOf(wasm) as Wasm & { __projdeckViewport?: boolean };
  if (proto.__projdeckViewport) return;
  proto.__projdeckViewport = true;
  const { write, resize } = proto;
  proto.write = function (this: Wasm, ...args: unknown[]) {
    this.__viewport = null;
    return write.apply(this, args);
  };
  proto.resize = function (this: Wasm, ...args: unknown[]) {
    this.__viewport = null;
    return resize.apply(this, args);
  };
  proto.getLine = function (this: Wasm, row: number) {
    if (row < 0 || row >= this._rows) return null;
    if (!this.__viewport) {
      this.update();
      this.__viewport = this.getViewport();
    }
    return this.__viewport.slice(row * this._cols, (row + 1) * this._cols);
  };
}

/**
 * 新建的 WASM 终端会复用上一个终端（已释放）的内存而不清空：收到输出之前，屏幕上是上一个会话的内容，
 * 还按新终端的列数错位显示（切换会话的一瞬间，远程访问延迟大时很明显）。新建后先清一次屏，把每个格子写成空白。
 */
const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";

/**
 * ghostty-web 的 reset() 会新建 WASM 终端实例，但选区管理器仍拿着旧实例（已释放）：
 * 选区照常高亮，取文字却读到空内容（复制出来只有换行），双击选词也失效。reset 后把新实例交给它，并清屏（原因同上）。
 */
function fixResetReferences(term: Terminal): void {
  const t = term as unknown as { reset(): void; write(data: string): void; wasmTerm?: unknown; selectionManager?: { wasmTerm: unknown } };
  const reset = t.reset;
  t.reset = function (this: typeof t) {
    reset.call(this);
    if (this.selectionManager) this.selectionManager.wasmTerm = this.wasmTerm;
    this.write(CLEAR_SCREEN);
  };
  t.write(CLEAR_SCREEN);
}

/**
 * 复制的文字里中文之间多出空格：宽字符占两格，第二格是空的占位格，ghostty-web 取选区文字时把它当成空格。
 * 这里照原逻辑重写，跳过宽字符后面的占位格（行尾空白照旧去掉）。
 */
function fixWideCharSelection(term: Terminal): void {
  type Cell = { codepoint: number; width: number; grapheme_len: number };
  type Pos = { col: number; absoluteRow: number };
  const sm = (term as unknown as { selectionManager?: Record<string, unknown> }).selectionManager as
    | {
        selectionStart: Pos | null;
        selectionEnd: Pos | null;
        wasmTerm: {
          getScrollbackLength(): number;
          getScrollbackLine(row: number): Cell[] | null;
          getLine(row: number): Cell[] | null;
          getScrollbackGraphemeString(row: number, col: number): string;
          getGraphemeString(row: number, col: number): string;
        };
        getSelection(): string;
      }
    | undefined;
  if (!sm) return;
  sm.getSelection = function (this: NonNullable<typeof sm>) {
    if (!this.selectionStart || !this.selectionEnd) return "";
    let { col: c0, absoluteRow: r0 } = this.selectionStart;
    let { col: c1, absoluteRow: r1 } = this.selectionEnd;
    if (r0 > r1 || (r0 === r1 && c0 > c1)) [c0, c1, r0, r1] = [c1, c0, r1, r0];
    const w = this.wasmTerm;
    const scrollback = w.getScrollbackLength();
    const out: string[] = [];
    for (let row = r0; row <= r1; row++) {
      const inScrollback = row < scrollback;
      const line = inScrollback ? w.getScrollbackLine(row) : w.getLine(row - scrollback);
      if (!line) continue;
      let text = "";
      for (let col = row === r0 ? c0 : 0, end = row === r1 ? c1 : line.length - 1; col <= end; col++) {
        const cell = line[col];
        if (!cell || cell.codepoint === 0) {
          if (col > 0 && line[col - 1]?.width === 2) continue; // 宽字符的占位格
          text += " ";
        } else if (cell.grapheme_len > 0) {
          text += inScrollback ? w.getScrollbackGraphemeString(row, col) : w.getGraphemeString(row - scrollback, col);
        } else text += String.fromCodePoint(cell.codepoint);
      }
      out.push(text.trimEnd());
    }
    return out.join("\n");
  };
}

/** 在 term.open() 之后调用。 */
export function patchRenderer(term: Terminal): void {
  const r = (term as unknown as { renderer: Renderer }).renderer;
  r.measureFont = measureFont;
  r.remeasureFont();
  // 中文等宽字符与原生 Ghostty 一样按正常字号、从格子左侧画，不放大
  r.renderLine = (line, row, cols) => renderLine(r, line, row, cols);
  r.renderCursor = (x, y) => renderCursor(r, x, y);
  cacheViewport(term);
  fixResetReferences(term);
  fixWideCharSelection(term);
  renderOnDemand(term, r);
}
