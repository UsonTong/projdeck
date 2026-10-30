import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api/models.dart';

/// 整个 App 的颜色，由电脑上 Ghostty 的配色推出来（与网页的 lib/terminalTheme.ts 相同的规则）：
/// 背景和文字取 Ghostty 的，其余是两者按比例混合；状态色取调色板的黄 / 红 / 绿。
class Palette extends ThemeExtension<Palette> {
  final Color bg, fg, card, popover, secondary, muted, mutedFg, accent, border, input, ring;
  final Color working, blocked, done, destructive, folder;
  final TerminalTheme terminal;

  const Palette._({
    required this.bg,
    required this.fg,
    required this.card,
    required this.popover,
    required this.secondary,
    required this.muted,
    required this.mutedFg,
    required this.accent,
    required this.border,
    required this.input,
    required this.ring,
    required this.working,
    required this.blocked,
    required this.done,
    required this.destructive,
    required this.folder,
    required this.terminal,
  });

  factory Palette.from(TerminalTheme t) {
    final bg = hexColor(t.background);
    final fg = hexColor(t.foreground);
    Color mix(double pct) => Color.lerp(bg, fg, pct / 100)!;
    Color pal(int i, String fallback) => hexColor(i < t.palette.length ? t.palette[i] : fallback);
    return Palette._(
      bg: bg,
      fg: fg,
      card: mix(4),
      popover: mix(6),
      secondary: mix(10),
      muted: mix(9),
      mutedFg: mix(58),
      accent: mix(11),
      border: mix(13),
      input: mix(17),
      ring: mix(40),
      working: pal(3, '#e5c07b'),
      blocked: pal(1, '#e06c75'),
      done: pal(2, '#98c379'),
      destructive: pal(1, '#e06c75'),
      folder: pal(4, '#61afef'),
      terminal: t,
    );
  }

  static Palette of(BuildContext context) => Theme.of(context).extension<Palette>()!;

  bool get dark => bg.computeLuminance() < 0.4;

  @override
  Palette copyWith() => this;

  @override
  Palette lerp(Palette? other, double t) => t < 0.5 ? this : (other ?? this);
}

Color hexColor(String hex) {
  var h = hex.replaceFirst('#', '');
  if (h.length == 3) h = h.split('').map((c) => '$c$c').join();
  return Color(int.parse(h.substring(0, 6), radix: 16) | 0xff000000);
}

const mono = 'monospace';

ThemeData buildTheme(Palette p) {
  final brightness = p.dark ? Brightness.dark : Brightness.light;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: p.fg,
    onPrimary: p.bg,
    secondary: p.secondary,
    onSecondary: p.fg,
    error: p.destructive,
    onError: p.bg,
    surface: p.bg,
    onSurface: p.fg,
    surfaceContainerLowest: p.bg,
    surfaceContainerLow: p.card,
    surfaceContainer: p.card,
    surfaceContainerHigh: p.popover,
    surfaceContainerHighest: p.secondary,
    onSurfaceVariant: p.mutedFg,
    outline: p.border,
    outlineVariant: p.border,
    inverseSurface: p.fg,
    onInverseSurface: p.bg,
  );
  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: p.bg,
    canvasColor: p.bg,
    dividerColor: p.border,
    splashFactory: InkSparkle.splashFactory,
    extensions: [p],
    appBarTheme: AppBarTheme(
      backgroundColor: p.bg,
      foregroundColor: p.fg,
      elevation: 0,
      scrolledUnderElevation: 0,
      systemOverlayStyle: (p.dark ? SystemUiOverlayStyle.light : SystemUiOverlayStyle.dark).copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: Colors.transparent,
      ),
    ),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: p.popover, showDragHandle: true, dragHandleColor: p.ring),
    dialogTheme: DialogThemeData(backgroundColor: p.popover),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: p.popover,
      contentTextStyle: TextStyle(color: p.fg),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: p.border),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.card,
      isDense: true,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: p.input),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: p.input),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: p.ring),
      ),
    ),
    pageTransitionsTheme: const PageTransitionsTheme(builders: {TargetPlatform.android: PredictiveBackPageTransitionsBuilder()}),
  );
}
