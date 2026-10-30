import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api/client.dart';
import 'api/models.dart';
import 'native.dart';
import 'pages/home_page.dart';
import 'pages/login_page.dart';
import 'pages/settings_page.dart';
import 'state.dart';
import 'theme.dart';
import 'widgets/session_tile.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  final prefs = await SharedPreferences.getInstance();
  runApp(ProjdeckApp(prefs: prefs));
}

class ProjdeckApp extends StatefulWidget {
  final SharedPreferences prefs;
  const ProjdeckApp({super.key, required this.prefs});

  @override
  State<ProjdeckApp> createState() => _ProjdeckAppState();
}

class _ProjdeckAppState extends State<ProjdeckApp> {
  final _nav = GlobalKey<NavigatorState>();
  AppState? _state;

  @override
  void initState() {
    super.initState();
    final link = widget.prefs.getString('link');
    final conn = link == null ? null : Connection.parse(link);
    if (conn != null) {
      _start(conn);
    } else {
      Native.initialLink().then((l) {
        final c = l == null ? null : Connection.parse(l);
        if (c != null) _connect(c);
      });
    }
    restartApp = () => setState(() {
      _state?.dispose();
      _state = null;
    });
    // 点通知打开 App：进入对应的会话
    Native.onOpen(_openPath);
    Native.initialPath().then((p) => p != null ? WidgetsBinding.instance.addPostFrameCallback((_) => _openPath(p)) : null);
  }

  void _start(Connection conn) {
    _state = AppState(conn, widget.prefs);
  }

  void _openPath(String path) {
    final m = RegExp(r'#/s/(.+)$').firstMatch(path);
    final ctx = _nav.currentContext;
    if (m == null || ctx == null || _state == null) return;
    _nav.currentState!.popUntil((r) => r.isFirst);
    openSession(ctx, Uri.decodeComponent(m.group(1)!));
  }

  Future<String?> _connect(Connection conn) async {
    try {
      await Api(conn).overview();
    } on ApiError catch (e) {
      return e.message;
    } catch (e) {
      return '连不上：$e';
    }
    await widget.prefs.setString('link', conn.url('/k/${conn.key}').toString());
    setState(() => _start(conn));
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final state = _state;
    final palette = Palette.from(state?.theme ?? TerminalTheme.fallback);
    // 登录前后是两套独立的页面栈：登录成功后不会留在登录页
    if (state == null) {
      return MaterialApp(
        key: const ValueKey('login'),
        title: 'projdeck',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(palette),
        home: LoginPage(onConnect: _connect),
      );
    }
    return AppScope(
      state: state,
      // 主题随电脑上的 Ghostty 配色变化
      child: ListenableBuilder(
        listenable: state,
        builder: (context, _) => MaterialApp(
          key: const ValueKey('app'),
          navigatorKey: _nav,
          title: 'projdeck',
          debugShowCheckedModeBanner: false,
          theme: buildTheme(Palette.from(state.theme)),
          home: const HomePage(),
        ),
      ),
    );
  }
}
