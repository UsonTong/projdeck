import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/io.dart';
import 'package:xterm/xterm.dart' as xt;

import '../state.dart';
import '../theme.dart';
import 'attach.dart';
import 'common.dart';

/// 原生终端：xterm.dart 渲染，通过 /ws/term 连接电脑上 herdr 的这个 pane（与网页终端同一个接口）。
/// 手势与网页一致：单指上下滑滚动历史（转成滚轮事件交给 herdr）、双指捏合调字号、轻点弹出键盘。
class TerminalPane extends StatefulWidget {
  final String paneId;
  const TerminalPane({super.key, required this.paneId});

  @override
  State<TerminalPane> createState() => TerminalPaneState();
}

class TerminalPaneState extends State<TerminalPane> with WidgetsBindingObserver {
  final terminal = xt.Terminal(maxLines: 2000);
  final controller = xt.TerminalController();
  final focus = FocusNode();
  IOWebSocketChannel? _ws;
  StreamSubscription? _sub;
  String _status = 'connecting';
  String? _error;
  bool _painted = false;
  int _cols = 0, _rows = 0;
  double _fontSize = 13;
  double _scaleBase = 13;
  double _scrollAcc = 0;
  Timer? _retry;
  bool _ctrl = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    SharedPreferences.getInstance().then((p) {
      final v = p.getDouble('termFontSize');
      if (v != null && mounted) setState(() => _fontSize = v);
    });
    terminal.onOutput = _input;
    terminal.onResize = (w, h, pw, ph) {
      _cols = w;
      _rows = h;
      if (_ws == null) {
        _connect();
      } else {
        _send({'t': 'r', 'c': w, 'r': h});
      }
    };
  }

  /// 所有输入的出口：处理快捷键条上的 Ctrl 粘滞键。
  void _input(String data) {
    if (_ctrl && data.length == 1) {
      final code = data.toUpperCase().codeUnitAt(0);
      if (code >= 0x40 && code <= 0x5f) data = String.fromCharCode(code & 0x1f);
      setState(() => _ctrl = false);
    }
    _send({'t': 'i', 'd': data});
  }

  void sendRaw(String data) => _send({'t': 'i', 'd': data});

  /// 以粘贴方式输入（支持 bracketed paste，agent 会当作一次粘贴处理）。
  void paste(String text) => terminal.paste(text);

  void sendKey(xt.TerminalKey key, {bool shift = false, bool ctrl = false}) => terminal.keyInput(key, shift: shift, ctrl: ctrl);

  bool get ctrlArmed => _ctrl;
  void toggleCtrl() => setState(() => _ctrl = !_ctrl);

  void _send(Map<String, Object?> msg) {
    if (_status == 'open') _ws?.sink.add(jsonEncode(msg));
  }

  void _connect() {
    if (!mounted || _cols == 0) return;
    final app = AppScope.read(context);
    _sub?.cancel();
    _ws?.sink.close();
    final uri = app.conn
        .ws('/ws/term')
        .replace(queryParameters: {'pane': widget.paneId, 'cols': '$_cols', 'rows': '$_rows', 'sizing': 'fit', 'active': '1'});
    setState(() {
      _status = 'connecting';
      _error = null;
    });
    final ws = IOWebSocketChannel.connect(uri, headers: app.conn.headers, pingInterval: const Duration(seconds: 20));
    _ws = ws;
    var first = true;
    ws.ready.then((_) {
      if (_ws == ws && mounted) setState(() => _status = 'open');
    }, onError: (_) {});
    _sub = ws.stream.listen(
      (data) {
        if (data is List<int>) {
          if (first) {
            first = false;
            // herdr 在连接时会完整重绘：清掉旧画面
            terminal.write('\x1b[2J\x1b[3J\x1b[H');
            if (!_painted) WidgetsBinding.instance.addPostFrameCallback((_) => mounted ? setState(() => _painted = true) : null);
          }
          terminal.write(_decode(data is Uint8List ? data : Uint8List.fromList(data)));
          return;
        }
        final msg = jsonDecode(data as String) as Map<String, dynamic>;
        if (msg['t'] == 'error') {
          setState(() {
            _status = 'error';
            _error = msg['message'] as String?;
          });
        }
      },
      onDone: () => _closed(ws),
      onError: (_) => _closed(ws),
    );
  }

  // 收到的字节可能在多字节字符（中文）中间断开：末尾不完整的部分留到下一段
  final _pending = <int>[];
  String _decode(Uint8List bytes) {
    // 把上次没解完的半个字符拼上
    final all = _pending.isEmpty ? bytes : Uint8List.fromList([..._pending, ...bytes]);
    _pending.clear();
    var end = all.length;
    // 找到末尾不完整的 UTF-8 序列
    for (var i = all.length - 1; i >= 0 && i >= all.length - 4; i--) {
      final b = all[i];
      if (b & 0xc0 == 0x80) continue; // 续字节
      final need = b >= 0xf0
          ? 4
          : b >= 0xe0
          ? 3
          : b >= 0xc0
          ? 2
          : 1;
      if (all.length - i < need) end = i;
      break;
    }
    if (end < all.length) _pending.addAll(all.sublist(end));
    return utf8.decode(all.sublist(0, end), allowMalformed: true);
  }

  void _closed(IOWebSocketChannel ws) {
    if (_ws != ws || !mounted) return;
    if (_status == 'error') return;
    setState(() => _status = 'closed');
    _retry?.cancel();
    _retry = Timer(const Duration(milliseconds: 1500), _connect);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _status != 'open' && _status != 'error') _connect();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _retry?.cancel();
    _sub?.cancel();
    _ws?.sink.close();
    focus.dispose();
    super.dispose();
  }

  // ---- 手势 ----

  void _onScaleStart(ScaleStartDetails d) {
    _scaleBase = _fontSize;
    _scrollAcc = 0;
  }

  void _onScaleUpdate(ScaleUpdateDetails d) {
    if (d.pointerCount >= 2) {
      final size = (_scaleBase * d.scale).clamp(8.0, 28.0);
      if ((size - _fontSize).abs() >= 0.5) setState(() => _fontSize = (size * 2).round() / 2);
      return;
    }
    // 手指上移 = 内容向下滚 = 滚轮向下
    _scrollAcc -= d.focalPointDelta.dy;
    final lineHeight = _fontSize * 1.2;
    while (_scrollAcc.abs() >= lineHeight) {
      final down = _scrollAcc > 0;
      terminal.mouseInput(
        down ? xt.TerminalMouseButton.wheelDown : xt.TerminalMouseButton.wheelUp,
        xt.TerminalMouseButtonState.down,
        xt.CellOffset(_cols ~/ 2, _rows ~/ 2),
      );
      _scrollAcc -= down ? lineHeight : -lineHeight;
    }
  }

  void _onScaleEnd(ScaleEndDetails d) {
    SharedPreferences.getInstance().then((p) => p.setDouble('termFontSize', _fontSize));
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final t = p.terminal;
    Color c(int i, String f) => hexColor(i < t.palette.length ? t.palette[i] : f);
    final theme = xt.TerminalTheme(
      cursor: hexColor(t.cursor),
      selection: hexColor(t.selectionBackground).withValues(alpha: 0.6),
      foreground: hexColor(t.foreground),
      background: hexColor(t.background),
      black: c(0, '#000000'),
      red: c(1, '#cd3131'),
      green: c(2, '#0dbc79'),
      yellow: c(3, '#e5e510'),
      blue: c(4, '#2472c8'),
      magenta: c(5, '#bc3fbc'),
      cyan: c(6, '#11a8cd'),
      white: c(7, '#e5e5e5'),
      brightBlack: c(8, '#666666'),
      brightRed: c(9, '#f14c4c'),
      brightGreen: c(10, '#23d18b'),
      brightYellow: c(11, '#f5f543'),
      brightBlue: c(12, '#3b8eea'),
      brightMagenta: c(13, '#d670d6'),
      brightCyan: c(14, '#29b8db'),
      brightWhite: c(15, '#e5e5e5'),
      searchHitBackground: c(3, '#e5e510'),
      searchHitBackgroundCurrent: c(11, '#f5f543'),
      searchHitForeground: hexColor(t.background),
    );
    return Container(
      color: hexColor(t.background),
      child: Stack(
        children: [
          // 第一段画面到了再淡入，不显示只有光标的空白终端
          AnimatedOpacity(
            opacity: _painted ? 1 : 0,
            duration: const Duration(milliseconds: 200),
            child: xt.TerminalView(
              terminal,
              controller: controller,
              focusNode: focus,
              theme: theme,
              padding: const EdgeInsets.all(4),
              textStyle: xt.TerminalStyle(fontSize: _fontSize, fontFamily: 'monospace'),
              keyboardType: TextInputType.text,
              keyboardAppearance: p.dark ? Brightness.dark : Brightness.light,
              deleteDetection: true,
            ),
          ),
          // 手势层盖在终端上：滚动、捏合、轻点
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () {
                focus.requestFocus();
                SystemChannels.textInput.invokeMethod('TextInput.show');
              },
              onScaleStart: _onScaleStart,
              onScaleUpdate: _onScaleUpdate,
              onScaleEnd: _onScaleEnd,
            ),
          ),
          if (_status != 'open' && (_status == 'error' || _painted))
            Positioned.fill(
              child: Container(
                color: hexColor(t.background).withValues(alpha: 0.85),
                alignment: Alignment.center,
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (_status == 'error') ...[
                      Icon(Icons.error_outline_rounded, color: p.destructive),
                      const SizedBox(height: 8),
                      Text(
                        _error ?? '连接出错',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: p.mutedFg),
                      ),
                      const SizedBox(height: 12),
                      OutlinedButton(onPressed: _connect, child: const Text('重试')),
                    ] else ...[
                      const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                      const SizedBox(height: 10),
                      Text(_status == 'connecting' ? '连接中…' : '已断开，正在重连…', style: TextStyle(color: p.mutedFg)),
                    ],
                  ],
                ),
              ),
            ),
          if (!_painted && _status != 'error') const Center(child: SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))),
        ],
      ),
    );
  }
}

/// 终端下方的快捷键条（手机软键盘上没有的键）。方向键按住连发。
class KeyBar extends StatefulWidget {
  final GlobalKey<TerminalPaneState> term;
  final String paneId;
  const KeyBar({super.key, required this.term, required this.paneId});

  @override
  State<KeyBar> createState() => _KeyBarState();
}

class _KeyBarState extends State<KeyBar> {
  Timer? _repeat;

  @override
  void dispose() {
    _repeat?.cancel();
    super.dispose();
  }

  Widget _key(String label, VoidCallback onPress, {bool repeat = false, bool active = false}) {
    final p = Palette.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: Material(
        color: active ? p.fg : p.secondary,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () {
            HapticFeedback.selectionClick();
            onPress();
          },
          onLongPress: repeat ? () => _repeat = Timer.periodic(const Duration(milliseconds: 70), (_) => onPress()) : null,
          onTapCancel: () => _repeat?.cancel(),
          child: Listener(
            onPointerUp: (_) => _repeat?.cancel(),
            child: Container(
              constraints: const BoxConstraints(minWidth: 42),
              height: 36,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              alignment: Alignment.center,
              child: Text(
                label,
                style: TextStyle(fontFamily: mono, fontSize: 13, color: active ? p.bg : p.fg),
              ),
            ),
          ),
        ),
      ),
    );
  }

  int _uploading = 0;

  /// 上传图片或文件，把电脑上的路径粘贴进终端（agent 会读取它；图片会被当作图片附件）。
  Future<void> _attach() async {
    final files = await pickAttachments(context);
    if (files.isEmpty || !mounted) return;
    final app = AppScope.read(context);
    setState(() => _uploading += files.length);
    for (final f in files) {
      final u = await run(context, () => app.api.uploadForSession(widget.paneId, f));
      if (!mounted) return;
      setState(() => _uploading--);
      if (u != null) widget.term.currentState?.paste('${u.path} ');
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final t = widget.term.currentState;
    void key(xt.TerminalKey k, {bool shift = false, bool ctrl = false}) => widget.term.currentState?.sendKey(k, shift: shift, ctrl: ctrl);
    return Container(
      color: p.card,
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
      child: Row(
        children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  _key('ctrl', () => setState(() => widget.term.currentState?.toggleCtrl()), active: t?.ctrlArmed ?? false),
                  _key('esc', () => key(xt.TerminalKey.escape)),
                  _key('tab', () => key(xt.TerminalKey.tab)),
                  _key('⇧tab', () => key(xt.TerminalKey.tab, shift: true)),
                  _key('↑', () => key(xt.TerminalKey.arrowUp), repeat: true),
                  _key('↓', () => key(xt.TerminalKey.arrowDown), repeat: true),
                  _key('←', () => key(xt.TerminalKey.arrowLeft), repeat: true),
                  _key('→', () => key(xt.TerminalKey.arrowRight), repeat: true),
                  _key('⏎', () => key(xt.TerminalKey.enter)),
                  _key('^C', () => key(xt.TerminalKey.keyC, ctrl: true)),
                  _key('/', () => widget.term.currentState?.sendRaw('/')),
                  _key('|', () => widget.term.currentState?.sendRaw('|')),
                  _key('~', () => widget.term.currentState?.sendRaw('~')),
                ],
              ),
            ),
          ),
          IconButton(
            tooltip: '上传图片或文件，把路径粘贴到终端',
            onPressed: _uploading > 0 ? null : _attach,
            icon: _uploading > 0
                ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.attach_file_rounded),
          ),
        ],
      ),
    );
  }
}
