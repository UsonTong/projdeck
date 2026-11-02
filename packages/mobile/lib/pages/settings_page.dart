import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../native.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/common.dart';
import 'devices_page.dart';
import 'remote_adb_page.dart';

/// 设置：通知（这台手机）、自动信任文件夹（全局）、断开连接。
class SettingsPage extends StatefulWidget {
  final VoidCallback? onLogout;
  const SettingsPage({super.key, this.onLogout});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  bool? _notify;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    Native.notificationsEnabled().then((v) => mounted ? setState(() => _notify = v) : null);
  }

  Future<void> _setNotify(bool on) async {
    setState(() => _busy = true);
    final ok = await Native.setNotifications(on, AppScope.read(context).conn);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (ok) _notify = on;
    });
    if (!ok) toast(context, '没有通知权限：请在系统设置里允许 projdeck 发通知', error: true);
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final p = Palette.of(context);
    final autoTrust = app.overview?.autoTrust ?? true;
    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        children: [
          _Section('通知（这台手机）'),
          SwitchListTile(
            title: const Text('完成和需处理时通知我'),
            subtitle: Text('App 在后台和电脑保持一条连接，不经过谷歌推送，国内网络也能收到。状态栏会有一条「正在接收通知」的常驻通知。', style: TextStyle(color: p.mutedFg, fontSize: 12)),
            value: _notify ?? false,
            onChanged: _notify == null || _busy ? null : _setNotify,
          ),
          if (_notify == true)
            ListTile(
              leading: const Icon(Icons.notifications_active_outlined),
              title: const Text('发一条测试通知'),
              onTap: () => run(context, app.api.notifyTest),
            ),
          _Section('会话'),
          SwitchListTile(
            title: const Text('自动信任文件夹'),
            subtitle: Text('Claude / Codex 问「是否信任这个文件夹」时自动选「信任」（Pi 不会问）。', style: TextStyle(color: p.mutedFg, fontSize: 12)),
            value: autoTrust,
            onChanged: (v) => run(context, () => app.api.patch('/api/settings', {'autoTrust': v})),
          ),
          _Section('远程调试'),
          ListTile(
            leading: const Icon(Icons.smartphone_rounded),
            title: const Text('设备'),
            subtitle: Text('连进 projdeck 的手机', style: TextStyle(color: p.mutedFg, fontSize: 12)),
            trailing: Icon(Icons.chevron_right_rounded, color: p.mutedFg),
            onTap: () => DevicesPage.open(context),
          ),
          ListTile(
            leading: const Icon(Icons.usb_rounded),
            title: const Text('远程 adb'),
            subtitle: Text('让公司电脑上的 adb 连到这台手机', style: TextStyle(color: p.mutedFg, fontSize: 12)),
            trailing: Icon(Icons.chevron_right_rounded, color: p.mutedFg),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const RemoteAdbPage())),
          ),
          _Section('连接'),
          ListTile(
            leading: const Icon(Icons.computer_rounded),
            title: Text(app.conn.base.toString()),
            subtitle: Text(app.connected ? '已连接' : '正在连接…', style: TextStyle(color: app.connected ? p.done : p.mutedFg)),
          ),
          ListTile(
            leading: Icon(Icons.logout_rounded, color: p.destructive),
            title: Text('断开并更换访问链接', style: TextStyle(color: p.destructive)),
            onTap: () async {
              if (!await confirm(context, title: '断开连接？', body: '需要重新粘贴访问链接才能再连上。', action: '断开', destructive: true)) return;
              final prefs = await SharedPreferences.getInstance();
              await prefs.remove('link');
              await Native.setNotifications(false, app.conn);
              if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
              restartApp();
            },
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  final String text;
  const _Section(this.text);

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 20, 16, 4),
    child: Text(text, style: TextStyle(fontSize: 13, color: Palette.of(context).mutedFg)),
  );
}

/// 断开后回到登录页（由 main.dart 设置）。
void Function() restartApp = () {};
