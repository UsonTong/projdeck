import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state.dart';
import '../theme.dart';
import '../widgets/common.dart';

/// 设备：连进 projdeck 的设备。目前是通过「远程 adb」连上来的安卓手机，手机 App 每 30 秒报一次状态；
/// 手机断开后还会留着最后一次的样子（标成不在线）。
class DevicesPage extends StatefulWidget {
  const DevicesPage({super.key});

  static void open(BuildContext context) =>
      Navigator.of(context)
          .push(MaterialPageRoute(builder: (_) => const DevicesPage()));

  @override
  State<DevicesPage> createState() => _DevicesPageState();
}

class _DevicesPageState extends State<DevicesPage> {
  List<Map<String, dynamic>>? _devices;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _load();
      _timer = Timer.periodic(const Duration(seconds: 5), (_) => _load());
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await AppScope.read(context).api.get('/api/devices');
      final list = (r['devices'] as List).cast<Map<String, dynamic>>();
      if (mounted) setState(() => _devices = list);
    } catch (_) {
      // 下次轮询再试
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final devices = _devices;
    return Scaffold(
      appBar: AppBar(title: const Text('设备')),
      body: devices == null
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 40),
              children: [
                if (devices.isEmpty)
                  Container(
                    padding: const EdgeInsets.all(20),
                    decoration: BoxDecoration(
                      border: Border.all(color: p.border),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Text(
                      '还没有设备连进来。\n在手机的 projdeck App 里打开「设置 → 远程 adb」，打开「远程连接」开关，手机就会出现在这里。',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 13,
                        color: p.mutedFg,
                        height: 1.5,
                      ),
                    ),
                  ),
                for (final d in devices) _DeviceCard(d: d),
              ],
            ),
    );
  }
}

String _ago(int ms) {
  final s = ((DateTime.now().millisecondsSinceEpoch - ms) / 1000).round().clamp(
    0,
    1 << 31,
  );
  if (s < 60) return '刚刚';
  if (s < 3600) return '${s ~/ 60} 分钟';
  if (s < 86400) return '${s ~/ 3600} 小时';
  return '${s ~/ 86400} 天';
}

class _DeviceCard extends StatelessWidget {
  final Map<String, dynamic> d;
  const _DeviceCard({required this.d});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final online = d['online'] == true;
    final adb = d['adb'] as Map<String, dynamic>?;
    final battery = d['battery'] as int?;
    final network = d['network'] as String?;
    final tcp = d['tcpMode'] as bool?;
    final sub = [
      d['os'] as String? ?? '',
      if (d['appVersion'] != null) 'projdeck ${d['appVersion']}',
    ].where((e) => e.isNotEmpty).join(' · ');
    final facts = <(IconData, String)>[
      if (battery != null)
        (
          d['charging'] == true
              ? Icons.battery_charging_full_rounded
              : Icons.battery_std_rounded,
          '$battery%${d['charging'] == true ? ' 充电中' : ''}',
        ),
      if (network != null)
        (
          network == 'wifi'
              ? Icons.wifi_rounded
              : network == 'mobile'
              ? Icons.signal_cellular_alt_rounded
              : Icons.wifi_off_rounded,
          const {'wifi': 'Wi‑Fi', 'mobile': '移动数据', 'none': '没有网络'}[network]!,
        ),
      if (d['vpn'] == true) (Icons.shield_outlined, '手机上开着 VPN'),
      if (tcp != null)
        (
          tcp
              ? Icons.check_circle_outline_rounded
              : Icons.error_outline_rounded,
          tcp ? 'adb 就绪' : 'adb 的 TCP 模式没开（会自动恢复）',
        ),
    ];
    return Opacity(
      opacity: online ? 1 : 0.7,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: p.card,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: p.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: p.muted,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Icon(Icons.smartphone_rounded, size: 22),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        d['name'] as String? ?? '',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (sub.isNotEmpty)
                        Text(
                          sub,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: p.mutedFg),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: online ? p.done : p.mutedFg,
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  online
                      ? '在线 ${_ago((d['since'] ?? d['lastSeen']) as int)}'
                      : '${_ago(d['lastSeen'] as int)}前离线',
                  style: TextStyle(
                    fontSize: 12,
                    color: online ? p.done : p.mutedFg,
                  ),
                ),
              ],
            ),
            if (online && facts.isNotEmpty) ...[
              const SizedBox(height: 10),
              Wrap(
                spacing: 14,
                runSpacing: 6,
                children: [
                  for (final (icon, text) in facts)
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(icon, size: 16, color: p.mutedFg),
                        const SizedBox(width: 5),
                        Text(
                          text,
                          style: TextStyle(fontSize: 13, color: p.mutedFg),
                        ),
                      ],
                    ),
                ],
              ),
            ],
            if (adb != null) ...[
              const SizedBox(height: 10),
              InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () {
                  Clipboard.setData(
                    ClipboardData(text: adb['command'] as String),
                  );
                  toast(context, '已复制');
                },
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    color: p.muted,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          adb['command'] as String,
                          style: const TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 13,
                          ),
                        ),
                      ),
                      Icon(Icons.copy_rounded, size: 16, color: p.mutedFg),
                    ],
                  ),
                ),
              ),
              if ((adb['connections'] as int) > 0)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    '电脑上正有 ${adb['connections']} 个 adb 连接',
                    style: TextStyle(fontSize: 12, color: p.mutedFg),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}
