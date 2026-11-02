import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme.dart';

/// Claude Code 的螃蟹、Codex 的小家伙：按它们在终端里打印的标志逐像素还原（与网页的 AgentIcon 相同）。
/// 终端里一个「像素」是半个字符格，宽高约 1:2，所以每个像素画成 1×2 的矩形。
const _crab = ['...############...', '...##.######.##...', '.################.', '...############...', '....#.#....#.#....'];
const _codex = [
  '.#............#.',
  '..############..',
  '.##.###########.',
  '.###.##########.',
  '.##.###....####.',
  '..############..',
  '...#.#....#.#...',
];

/// Pi：像素的希腊字母 π。
const _pi = ['###############', '###############', '..##.......##..', '..##.......##..', '..##.......##..', '..##.......###.', '..##........##.'];

/// 能新开的 agent，按默认顺序。
const agentKinds = [SessionKind.claude, SessionKind.codex, SessionKind.pi];

const claudeColor = Color(0xffd97757);
const codexColor = Color(0xffbae6fd);
const piColor = Color(0xffc4b5fd);

class _PixelPainter extends CustomPainter {
  final List<String> rows;
  final Color color;
  _PixelPainter(this.rows, this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final w = rows[0].length;
    final h = rows.length * 2;
    final unit = (size.width / w).clamp(0, size.height / h).toDouble();
    final dx = (size.width - unit * w) / 2;
    final dy = (size.height - unit * h) / 2;
    final paint = Paint()
      ..color = color
      ..isAntiAlias = false;
    for (var y = 0; y < rows.length; y++) {
      for (var x = 0; x < w; x++) {
        if (rows[y][x] == '#') canvas.drawRect(Rect.fromLTWH(dx + x * unit, dy + y * 2 * unit, unit + 0.3, unit * 2 + 0.3), paint);
      }
    }
  }

  @override
  bool shouldRepaint(_PixelPainter old) => old.color != color || old.rows != rows;
}

/// 会话类型图标，可带状态角标（工作中会呼吸闪烁 / 需处理 / 已完成）或「新开」的加号。
class AgentIcon extends StatelessWidget {
  final SessionKind kind;
  final SessionStatus? status;
  final double size;
  final bool plus;
  const AgentIcon({super.key, required this.kind, this.status, this.size = 36, this.plus = false});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final (bg, fg, ring) = switch (kind) {
      SessionKind.claude => (claudeColor.withValues(alpha: 0.12), claudeColor, claudeColor.withValues(alpha: 0.25)),
      SessionKind.codex => (const Color(0xff38bdf8).withValues(alpha: 0.10), codexColor, const Color(0xff7dd3fc).withValues(alpha: 0.25)),
      SessionKind.pi => (const Color(0xffa78bfa).withValues(alpha: 0.10), piColor, const Color(0xffc4b5fd).withValues(alpha: 0.25)),
      SessionKind.shell => (p.muted, p.mutedFg, p.border),
    };
    final dot = switch (status) {
      SessionStatus.working => p.working,
      SessionStatus.blocked => p.blocked,
      SessionStatus.done => p.done,
      _ => null,
    };
    return SizedBox.square(
      dimension: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            decoration: BoxDecoration(
              color: bg,
              borderRadius: BorderRadius.circular(size * 0.28),
              border: Border.all(color: ring),
            ),
            alignment: Alignment.center,
            child: kind == SessionKind.shell
                ? Icon(Icons.terminal_rounded, size: size * 0.55, color: fg)
                : SizedBox(
                    width: size * (kind == SessionKind.claude ? 0.78 : kind == SessionKind.pi ? 0.62 : 0.72),
                    height: size * 0.7,
                    child: CustomPaint(painter: _PixelPainter(kind == SessionKind.claude ? _crab : kind == SessionKind.pi ? _pi : _codex, fg)),
                  ),
          ),
          if (plus)
            Positioned(
              right: -3,
              bottom: -3,
              child: Container(
                width: size * 0.42,
                height: size * 0.42,
                decoration: BoxDecoration(
                  color: p.fg,
                  shape: BoxShape.circle,
                  border: Border.all(color: p.bg, width: 2),
                ),
                child: Icon(Icons.add, size: size * 0.32, color: p.bg),
              ),
            ),
          if (dot != null)
            Positioned(
              right: -2,
              bottom: -2,
              child: _StatusDot(color: dot, pulse: status == SessionStatus.working, size: size * 0.3, ring: p.bg),
            ),
        ],
      ),
    );
  }
}

class _StatusDot extends StatefulWidget {
  final Color color;
  final Color ring;
  final bool pulse;
  final double size;
  const _StatusDot({required this.color, required this.ring, required this.pulse, required this.size});

  @override
  State<_StatusDot> createState() => _StatusDotState();
}

class _StatusDotState extends State<_StatusDot> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1000));

  @override
  void initState() {
    super.initState();
    if (widget.pulse) _c.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(_StatusDot old) {
    super.didUpdateWidget(old);
    if (widget.pulse && !_c.isAnimating) _c.repeat(reverse: true);
    if (!widget.pulse) _c.value = 1;
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: widget.pulse
          ? Tween(begin: 0.45, end: 1.0).animate(CurvedAnimation(parent: _c, curve: Curves.easeInOut))
          : const AlwaysStoppedAnimation(1),
      child: Container(
        width: widget.size,
        height: widget.size,
        decoration: BoxDecoration(
          color: widget.color,
          shape: BoxShape.circle,
          border: Border.all(color: widget.ring, width: 2),
        ),
      ),
    );
  }
}
