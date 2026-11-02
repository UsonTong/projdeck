import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../native.dart';
import '../state.dart';
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
    final relayEnabled = _s['relayEnabled'] == true;
    final relay = (_s['relay'] as String?) ?? 'off';
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
            detail: tcp
                ? 'adb 已经在手机的 5555 端口监听。手机重启后会失效，打开下面的「远程连接」后，连上 Wi-Fi 会自动恢复。'
                : '把手机的 adb 切到 TCP 模式，之后不需要 Wi-Fi。系统会在新的 Wi-Fi 上第一次弹框，选「始终允许」。打开下面的「远程连接」后会自动做这一步。',
            action: !paired || tcp ? null : _Btn('开启', _busy == 'tcp', () => _do('tcp', Native.adbEnableTcp)),
          ),
          _RelayCard(
            enabled: relayEnabled,
            state: relay,
            ready: paired && granted,
            onChanged: (on) async {
              final conn = AppScope.read(context).conn;
              await Native.adbRelaySet(on, conn);
              _refresh();
            },
          ),
          Padding(
            padding: const EdgeInsets.only(top: 4, bottom: 4),
            child: Text(
              '远程连接不是 VPN，不占手机唯一的 VPN 位，可以和 FlClash 同时开。建议在 FlClash 的「访问控制 / 应用代理」里把 projdeck 设为绕过，'
              '或给服务器地址加一条直连规则，这样转发不会绕道代理。',
              style: TextStyle(fontSize: 12, color: Palette.of(context).mutedFg, height: 1.5),
            ),
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

/// 第 4 步：允许公司电脑连接。开着时 App 在后台连着服务器，并自动保持 adb 的 TCP 模式。
class _RelayCard extends StatelessWidget {
  final bool enabled;
  final String state;
  final bool ready;
  final ValueChanged<bool> onChanged;
  const _RelayCard({required this.enabled, required this.state, required this.ready, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final (label, color) = switch ((enabled, state)) {
      (false, _) => ('已关闭', p.mutedFg),
      (true, 'connected') => ('已连上服务器，公司电脑可以连接', p.done),
      (true, _) => ('正在连接服务器…', p.working),
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: p.card,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: enabled && state == 'connected' ? p.done.withValues(alpha: 0.5) : p.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('远程连接', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 3),
                    Text(label, style: TextStyle(fontSize: 12.5, color: color)),
                  ],
                ),
              ),
              Switch(value: enabled, onChanged: ready || enabled ? onChanged : null),
            ],
          ),
          if (!ready && !enabled)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('先完成上面的配对和授权', style: TextStyle(fontSize: 12, color: p.mutedFg)),
            ),
          if (enabled && state == 'connected') ...[
            const SizedBox(height: 10),
            Text('在公司电脑上执行：', style: TextStyle(fontSize: 12, color: p.mutedFg)),
            const SizedBox(height: 4),
            InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () {
                Clipboard.setData(const ClipboardData(text: 'adb connect 127.0.0.1:15555'));
                toast(context, '已复制');
              },
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(color: p.muted, borderRadius: BorderRadius.circular(8)),
                child: Row(
                  children: [
                    const Expanded(
                      child: Text('adb connect 127.0.0.1:15555', style: TextStyle(fontFamily: mono, fontSize: 13)),
                    ),
                    Icon(Icons.copy_rounded, size: 16, color: p.mutedFg),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
