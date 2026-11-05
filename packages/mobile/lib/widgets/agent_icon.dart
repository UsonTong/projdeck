import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme.dart';

/// Claude Code 的螃蟹按它在终端里打印的标志逐像素还原；Codex 是官方的云朵 >_ 标志，Pi 是它启动时的三色方块（与网页的 AgentIcon 相同）。
/// 终端里一个「像素」是半个字符格，宽高约 1:2，所以每个像素画成 1×2 的矩形。
const _crab = ['...############...', '...##.######.##...', '.################.', '...############...', '....#.#....#.#....'];

/// Pi 启动时在终端里打印的标志：4×4 的三色方块，深色底（P 粉、B 蓝、Y 黄，. 为空）。
const _pi = ['PPP.', 'B.P.', 'BB.Y', 'B..Y'];
const _piColors = {'P': Color(0xfff09082), 'B': Color(0xff4d9abf), 'Y': Color(0xfff1be58)};

/// 能新开的 agent，按默认顺序。
const agentKinds = [SessionKind.claude, SessionKind.codex, SessionKind.pi, SessionKind.harness];

List<SessionKind> availableAgentKinds(Overview? overview) => [
  for (final k in agentKinds)
    if (k != SessionKind.harness || overview?.harness?.configured == true) k,
];

const claudeColor = Color(0xffd97757);
const codexColor = Colors.white;
const _codexBg = Color(0xff0b0c10);
const piColor = Color(0xff4d9abf);

/// Codex 的云朵 >_ 标志：白色圆瓣并集，再用底色小一圈的圆瓣盖住里面，留下一道描边（与网页相同，按 24×24 的坐标）。
class _CodexPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final k = size.width / 24;
    final lobes = [
      for (var i = 0; i < 6; i++) Offset(12 + 5.3 * math.cos(math.pi / 3 * i + math.pi / 6), 12 + 5.3 * math.sin(math.pi / 3 * i + math.pi / 6)),
    ];
    final white = Paint()..color = Colors.white;
    final bg = Paint()..color = _codexBg;
    canvas.drawCircle(Offset(12 * k, 12 * k), 6 * k, white);
    for (final l in lobes) {
      canvas.drawCircle(l * k, 4.4 * k, white);
    }
    canvas.drawCircle(Offset(12 * k, 12 * k), 5.2 * k, bg);
    for (final l in lobes) {
      canvas.drawCircle(l * k, 3.1 * k, bg);
    }
    final stroke = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5 * k
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.drawPath(
      Path()
        ..moveTo(8.3 * k, 9.7 * k)
        ..lineTo(11.4 * k, 12 * k)
        ..lineTo(8.3 * k, 14.3 * k)
        ..moveTo(12.9 * k, 14.6 * k)
        ..lineTo(16.2 * k, 14.6 * k),
      stroke,
    );
  }

  @override
  bool shouldRepaint(_CodexPainter old) => false;
}

/// Pi 的三色方块标志（方格是正方形，不像别的图标按 1×2 画）。
class _PiPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final cell = size.width / 4;
    for (var y = 0; y < _pi.length; y++) {
      for (var x = 0; x < _pi[y].length; x++) {
        final color = _piColors[_pi[y][x]];
        if (color != null) canvas.drawRect(Rect.fromLTWH(x * cell, y * cell, cell + 0.5, cell + 0.5), Paint()..color = color);
      }
    }
  }

  @override
  bool shouldRepaint(_PiPainter old) => false;
}

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
      SessionKind.codex => (_codexBg, codexColor, Colors.white.withValues(alpha: 0.10)),
      SessionKind.pi => (const Color(0xff151c26), piColor, Colors.white.withValues(alpha: 0.10)),
      SessionKind.shell => (p.muted, p.mutedFg, p.border),
      SessionKind.harness => (const Color(0xff4d6bfe), Colors.white, const Color(0xff4d6bfe)),
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
                : kind == SessionKind.harness
                ? Image.asset('assets/deepseek.png', width: size * 0.64, height: size * 0.64, fit: BoxFit.contain)
                : SizedBox(
                    width: size * (kind == SessionKind.claude ? 0.78 : kind == SessionKind.pi ? 0.5 : 0.7),
                    height: kind == SessionKind.claude ? size * 0.7 : kind == SessionKind.pi ? size * 0.5 : size * 0.7,
                    child: CustomPaint(
                      painter: kind == SessionKind.pi
                          ? _PiPainter()
                          : kind == SessionKind.codex
                          ? _CodexPainter()
                          : _PixelPainter(_crab, fg),
                    ),
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
