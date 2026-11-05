import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/io.dart';

import 'api/client.dart';
import 'api/models.dart';
import 'sort.dart';

/// 一个会话的对话记录（查看时由服务端增量推送）。
class PaneTranscript {
  List<TranscriptEntry> entries = [];
  String? conversationId;
  bool loaded = false;
}

/// App 的全部状态：连接、实时总览、主题、本机偏好。
/// 与网页的 live.ts 一样只用一条 WebSocket：总览推送 + 正在看的会话的对话记录。
class AppState extends ChangeNotifier with WidgetsBindingObserver {
  final Connection conn;
  final Api api;
  final SharedPreferences prefs;

  Overview? overview;
  bool connected = false;
  TerminalTheme theme;

  IOWebSocketChannel? _ws;
  StreamSubscription? _sub;
  Duration _backoff = const Duration(milliseconds: 500);
  Timer? _retry;
  final Map<String, int> _watching = {};
  /// 各会话输入框的草稿，电脑和手机会实时同步
  final Map<String, String> drafts = {};
  /// Agent 最近一次主动展示的图片
  PresentedResource? latestPresent;
  Timer? _draftTimer;
  final Map<String, PaneTranscript> transcripts = {};
  bool _disposed = false;

  AppState(this.conn, this.prefs) : api = Api(conn), theme = _cachedTheme(prefs) {
    WidgetsBinding.instance.addObserver(this);
    _connect();
    refreshTheme();
  }

  // ---- 本机偏好 ----
  ProjectSort get projectSort => ProjectSort.values.firstWhere((s) => s.name == prefs.getString('projectSort'), orElse: () => ProjectSort.status);
  set projectSort(ProjectSort v) {
    prefs.setString('projectSort', v.name);
    notifyListeners();
  }

  UnassignedSort get unassignedSort =>
      UnassignedSort.values.firstWhere((s) => s.name == prefs.getString('unassignedSort'), orElse: () => UnassignedSort.herdr);
  set unassignedSort(UnassignedSort v) {
    prefs.setString('unassignedSort', v.name);
    notifyListeners();
  }

  bool get showHidden => prefs.getBool('showHidden') ?? false;
  set showHidden(bool v) {
    prefs.setBool('showHidden', v);
    notifyListeners();
  }

  // ---- 连接 ----
  void _connect() {
    if (_disposed) return;
    _sub?.cancel();
    final ws = IOWebSocketChannel.connect(conn.ws('/ws'), headers: conn.headers, pingInterval: const Duration(seconds: 20));
    _ws = ws;
    ws.ready.then((_) {
      if (_ws != ws) return;
      connected = true;
      _backoff = const Duration(milliseconds: 500);
      for (final paneId in _watching.keys) {
        _send({'op': 'watch', 'paneId': paneId});
      }
      notifyListeners();
    }, onError: (_) {});
    _sub = ws.stream.listen(
      (data) => _handle(jsonDecode(data as String) as Map<String, dynamic>),
      onDone: () => _closed(ws),
      onError: (_) => _closed(ws),
      cancelOnError: true,
    );
  }

  void _closed(IOWebSocketChannel ws) {
    if (_ws != ws || _disposed) return;
    connected = false;
    notifyListeners();
    _retry?.cancel();
    _retry = Timer(_backoff, _connect);
    _backoff = Duration(milliseconds: (_backoff.inMilliseconds * 2).clamp(500, 10000));
  }

  void _send(Map<String, Object?> msg) {
    if (connected) _ws?.sink.add(jsonEncode(msg));
  }

  void _handle(Map<String, dynamic> msg) {
    switch (msg['type']) {
      case 'overview':
        overview = Overview.fromJson(msg['overview']);
      case 'theme':
        refreshTheme();
        return;
      case 'draft':
        // 服务端广播的草稿；正在输入时（见 setDraft 的标记）不覆盖
        final paneId = msg['paneId'] as String;
        if (paneId != _typingPane) {
          drafts[paneId] = msg['text'] as String? ?? '';
        }
      case 'present':
        latestPresent = PresentedResource.fromJson(msg['resource'] as Map<String, dynamic>);
      case 'transcript':
        final t = transcripts.putIfAbsent(msg['paneId'], PaneTranscript.new);
        final page = msg['page'] as Map<String, dynamic>;
        final entries = [for (final e in (page['entries'] as List)) TranscriptEntry.fromJson(e)];
        if (page['reset'] == true) {
          t.entries = entries;
        } else {
          final seen = {for (final e in t.entries) e.id};
          t.entries = [...t.entries, ...entries.where((e) => !seen.contains(e.id))];
        }
        t.conversationId = page['conversationId'];
        t.loaded = true;
    }
    notifyListeners();
  }

  /// 开始 / 停止接收某个会话的对话记录（可以多处同时看同一个会话）。
  /// 正在输入草稿的会话：这期间别的设备发来的草稿不覆盖本地输入。
  String? _typingPane;

  /// 输入时调用：本地立即生效，400ms 后才发给服务端。
  void setDraft(String paneId, String text) {
    drafts[paneId] = text;
    _typingPane = text.trim().isEmpty ? null : paneId;
    _draftTimer?.cancel();
    _draftTimer = Timer(const Duration(milliseconds: 400), () => _send({'op': 'draft', 'paneId': paneId, 'text': text}));
  }

  /// 发送后清空草稿，并立刻告诉其他设备。
  void clearDraft(String paneId) {
    _draftTimer?.cancel();
    _typingPane = null;
    drafts[paneId] = '';
    _send({'op': 'draft', 'paneId': paneId, 'text': ''});
  }

  void watch(String paneId) {
    _watching[paneId] = (_watching[paneId] ?? 0) + 1;
    if (_watching[paneId] == 1) _send({'op': 'watch', 'paneId': paneId});
  }

  void unwatch(String paneId) {
    final n = (_watching[paneId] ?? 1) - 1;
    if (n > 0) {
      _watching[paneId] = n;
      return;
    }
    _watching.remove(paneId);
    _send({'op': 'unwatch', 'paneId': paneId});
  }

  /// 主题缓存在手机上：下次打开时不用等网络就是正确的配色。
  static TerminalTheme _cachedTheme(SharedPreferences prefs) {
    final raw = prefs.getString('theme');
    if (raw == null) return TerminalTheme.fallback;
    try {
      return TerminalTheme.fromJson(jsonDecode(raw));
    } catch (_) {
      return TerminalTheme.fallback;
    }
  }

  Future<void> refreshTheme() async {
    try {
      final raw = await api.get('/api/terminal-theme');
      prefs.setString('theme', jsonEncode(raw));
      theme = TerminalTheme.fromJson(raw);
      if (!_disposed) notifyListeners();
    } catch (_) {
      // 用默认配色
    }
  }

  /// 回到前台时立刻重连（后台时系统可能已经断开了连接）。
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && !connected) {
      _retry?.cancel();
      _backoff = const Duration(milliseconds: 500);
      _connect();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _retry?.cancel();
    _sub?.cancel();
    _ws?.sink.close();
    super.dispose();
  }
}

/// 在组件树里取到 AppState：AppScope.of(context)。
class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child}) : super(notifier: state);

  static AppState of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
  static AppState read(BuildContext context) => context.getInheritedWidgetOfExactType<AppScope>()!.notifier!;
}
