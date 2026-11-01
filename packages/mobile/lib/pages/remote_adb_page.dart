import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../native.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// 远程调试：让电脑上的 adb 连到这台手机（原理见 docs/REMOTE_ADB.md）。
/// 三步：配对（一次）→ 授权（自动）→ 切到 TCP 模式（重启手机后需要再来一次，之后会改成自动）。
class RemoteAdbPage extends StatefulWidget {
  const RemoteAdbPage({super.key});

  @override
  State<RemoteAdbPage> createState() => _RemoteAdbPageState();
}

class _RemoteAdbPageState extends State<RemoteAdbPage> with WidgetsBindingObserver {
  Map<String, dynamic> _s = {};
  Timer? _timer;
  String? _busy;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async {
    final s = await Native.adbStatus();
    if (mounted) setState(() => _s = s);
  }

  Future<void> _do(String name, Future<String> Function() action) async {
    setState(() => _busy = name);
    try {
      final msg = await action();
      if (mounted) toast(context, msg);
    } on PlatformException catch (e) {
      if (mounted) toast(context, e.message ?? '失败', error: true);
    }
    if (mounted) setState(() => _busy = null);
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final paired = _s['paired'] == true;
    final granted = _s['secureGranted'] == true;
    final tcp = _s['tcp'] == true;
    final helper = _s['accessibility'] == true;
    final msg = (_s['message'] as String?) ?? '';
    return Scaffold(
      appBar: AppBar(title: const Text('远程调试')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 40),
        children: [
          Text('让公司电脑上的 adb 连到这台手机：手机只需要装着 projdeck、能上网。第一次设置要连着 Wi-Fi，之后用流量也可以。', style: TextStyle(color: p.mutedFg, height: 1.5, fontSize: 13)),
          const SizedBox(height: 16),
          _Step(
            index: 1,
            title: '配对',
            done: paired,
            detail: paired
                ? '已配对，以后不用再配'
                : helper
                ? '点「开始配对」会跳到开发者选项。打开「无线调试」，点「使用配对码配对」，配对助手会自动读取屏幕上的配对码，不用你输入。'
                : '先在系统的「无障碍」里打开「projdeck 配对助手」。它只能看到系统设置里的内容，只用来读取配对码，配对完会自动关闭。',
            action: paired
                ? null
                : helper
                ? _Btn('开始配对', false, () async {
                    await Native.adbStartPairing();
                    // 直接跳到开发者选项：打开「无线调试」，点「使用配对码配对」
                    if (!await Native.openDeveloperSettings() && context.mounted) {
                      toast(context, '请到系统设置的「开发者选项 → 无线调试」里点「使用配对码配对」', error: true);
                    }
                  })
                : _Btn('去打开', false, Native.openAccessibilitySettings),
          ),
          _Step(
            index: 2,
            title: '授权',
            done: granted,
            detail: granted ? 'App 已经能自己开关无线调试' : '配对后会自动授权。没成功的话，保持「无线调试」打开，点右边的按钮再试。',
            action: !paired || granted ? null : _Btn('授权', _busy == 'grant', () => _do('grant', Native.adbGrantSelf)),
          ),
          _Step(
            index: 3,
            title: 'TCP 模式',
            done: tcp,
            detail: tcp ? 'adb 已经在手机的 5555 端口监听，电脑可以通过转发通道连上。手机重启后失效。' : '把手机的 adb 切到 TCP 模式，之后不需要 Wi-Fi。系统会在新的 Wi-Fi 上第一次弹框，选「始终允许」。',
            action: !paired || tcp ? null : _Btn('开启', _busy == 'tcp', () => _do('tcp', Native.adbEnableTcp)),
          ),
          if (msg.isNotEmpty) ...[const SizedBox(height: 16), Text('最近一次：$msg', style: TextStyle(fontSize: 12, color: p.mutedFg))],
        ],
      ),
    );
  }
}

class _Btn {
  final String label;
  final bool busy;
  final Future<void> Function() onTap;
  _Btn(this.label, this.busy, this.onTap);
}

class _Step extends StatelessWidget {
  final int index;
  final String title;
  final bool done;
  final String detail;
  final _Btn? action;
  const _Step({required this.index, required this.title, required this.done, required this.detail, this.action});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: p.card,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: done ? p.done.withValues(alpha: 0.5) : p.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            width: 26,
            height: 26,
            alignment: Alignment.center,
            decoration: BoxDecoration(shape: BoxShape.circle, color: done ? p.done : p.muted),
            child: done ? Icon(Icons.check_rounded, size: 16, color: p.bg) : Text('$index', style: TextStyle(fontSize: 13, color: p.mutedFg)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                const SizedBox(height: 3),
                Text(detail, style: TextStyle(fontSize: 12.5, color: p.mutedFg, height: 1.5)),
              ],
            ),
          ),
          if (action != null)
            Padding(
              padding: const EdgeInsets.only(left: 8),
              child: FilledButton(
                onPressed: action!.busy ? null : () => action!.onTap(),
                child: action!.busy ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)) : Text(action!.label),
              ),
            ),
        ],
      ),
    );
  }
}
