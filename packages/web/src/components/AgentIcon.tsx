import type { SessionKind, SessionStatus } from "@projdeck/shared";
import { PlusIcon, SquareTerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 像素图标。终端里一个「像素」是半个字符格，宽高约 1:2，所以每个像素画成 1×2 的矩形，
 * 与在终端里看到的比例一致。行用字符串描述：'#' 填充，'.' 留空（透出背景，如螃蟹的眼睛）。
 */
function PixelArt({ rows, className, title }: { rows: string[]; className?: string; title: string }) {
  const w = rows[0]!.length;
  const h = rows.length * 2;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} role="img" aria-label={title} shapeRendering="crispEdges">
      {rows.flatMap((row, y) =>
        [...row].map((c, x) => (c === "#" ? <rect key={`${x}-${y}`} x={x} y={y * 2} width={1.02} height={2.02} fill="currentColor" /> : null)),
      )}
    </svg>
  );
}

/**
 * Claude Code 的螃蟹，按它在终端里打印的标志逐像素还原：
 *  ▐▛███▜▌
 * ▝▜█████▛▘
 *   ▘▘ ▝▝
 */
const CRAB = [
  "...############...",
  "...##.######.##...",
  ".################.",
  "...############...",
  "....#.#....#.#....",
];

/**
 * Codex 的官方标志：白色描边的云朵（六个圆瓣），里面是命令行提示符 >_，深色底。
 * 轮廓的画法：先画一圈白色的圆瓣并集，再在同样的圆心上画小一圈的底色圆瓣并集盖住里面，留下一道沿着外形走的描边。
 */
const CODEX_BG = "#0b0c10";
const LOBES = Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 3) * i + Math.PI / 6;
  return { x: 12 + 5.3 * Math.cos(a), y: 12 + 5.3 * Math.sin(a) };
});

function CodexLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Codex">
      <g fill="#fff">
        <circle cx="12" cy="12" r="6" />
        {LOBES.map((l, i) => (
          <circle key={i} cx={l.x} cy={l.y} r="4.4" />
        ))}
      </g>
      <g fill={CODEX_BG}>
        <circle cx="12" cy="12" r="5.2" />
        {LOBES.map((l, i) => (
          <circle key={i} cx={l.x} cy={l.y} r="3.1" />
        ))}
      </g>
      <path d="M8.3 9.7 11.4 12 8.3 14.3M12.9 14.6h3.3" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Pi 启动时在终端里打印的标志：4×4 的三色方块，深色底。
 *   P P P .      P 粉 #f09082
 *   B . P .      B 蓝 #4d9abf
 *   B B . Y      Y 黄 #f1be58
 *   B . . Y
 */
const PI_COLORS: Record<string, string> = { P: "#f09082", B: "#4d9abf", Y: "#f1be58" };
const PI = ["PPP.", "B.P.", "BB.Y", "B..Y"];

function PiLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 4 4" className={className} role="img" aria-label="Pi" shapeRendering="crispEdges">
      {PI.flatMap((row, y) =>
        [...row].map((c, x) => (PI_COLORS[c] ? <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={PI_COLORS[c]} /> : null)),
      )}
    </svg>
  );
}

const STATUS_DOT: Partial<Record<SessionStatus, string>> = {
  working: "bg-status-working animate-pulse transition-colors duration-500",
  blocked: "bg-status-blocked transition-colors duration-500",
  done: "bg-status-done transition-colors duration-500",
};

/** 会话类型图标，可带状态角标（工作中 / 需处理 / 已完成）。 */
export function AgentIcon({
  kind,
  status,
  size = "md",
  plus = false,
  className,
}: {
  kind: SessionKind;
  status?: SessionStatus;
  /** 右下角加号：表示「新开一个这种会话」。 */
  plus?: boolean;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const box = { xs: "size-5 rounded-md", sm: "size-6", md: "size-8", lg: "size-9" }[size];
  const dot = status && STATUS_DOT[status];
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-lg ring-1",
        box,
        kind === "claude" && "bg-[#d97757]/12 text-[#d97757] ring-[#d97757]/25",
        kind === "codex" && "bg-[#0b0c10] ring-white/10",
        kind === "pi" && "bg-[#151c26] ring-white/10",
        kind === "harness" && "bg-[#4d6bfe] ring-[#4d6bfe]/40",
        kind === "shell" && "bg-muted text-muted-foreground ring-border",
        className,
      )}
    >
      {kind === "claude" && <PixelArt rows={CRAB} title="Claude" className="w-[78%]" />}
      {kind === "codex" && <CodexLogo className="w-[78%]" />}
      {kind === "pi" && <PiLogo className="w-[52%]" />}
      {kind === "harness" && <img src="/deepseek.svg" alt="DeepSeek" draggable={false} className="w-[62%]" />}
      {kind === "shell" && <SquareTerminalIcon className="size-[55%]" />}
      {plus && (
        <span className="absolute -right-1 -bottom-1 flex size-3 items-center justify-center rounded-full bg-foreground text-background ring-2 ring-background">
          <PlusIcon className="size-2.5" strokeWidth={3.5} />
        </span>
      )}
      {dot && (
        <span className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background", dot)} title={status} />
      )}
    </span>
  );
}
