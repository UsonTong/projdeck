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

/** Codex：同风格的像素小家伙，头顶两根天线，脸是 Codex 的提示符 >_。 */
const CODEX = [
  ".#............#.",
  "..############..",
  ".##.###########.",
  ".###.##########.",
  ".##.###....####.",
  "..############..",
  "...#.#....#.#...",
];

/** Pi：像素的希腊字母 π（pi 的名字，也是它在终端里的标志）。 */
const PI = [
  "###############",
  "###############",
  "..##.......##..",
  "..##.......##..",
  "..##.......##..",
  "..##.......###.",
  "..##........##.",
];

const STATUS_DOT: Partial<Record<SessionStatus, string>> = {
  working: "bg-status-working animate-pulse",
  blocked: "bg-status-blocked",
  done: "bg-status-done",
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
        kind === "codex" && "bg-sky-400/10 text-sky-200 ring-sky-300/25",
        kind === "pi" && "bg-violet-400/10 text-violet-300 ring-violet-300/25",
        kind === "shell" && "bg-muted text-muted-foreground ring-border",
        className,
      )}
    >
      {kind === "claude" && <PixelArt rows={CRAB} title="Claude" className="w-[78%]" />}
      {kind === "codex" && <PixelArt rows={CODEX} title="Codex" className="w-[72%]" />}
      {kind === "pi" && <PixelArt rows={PI} title="Pi" className="w-[62%]" />}
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
