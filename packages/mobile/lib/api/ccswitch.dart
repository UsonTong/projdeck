import 'client.dart';

// CC Switch（AI 编程工具的供应商管理器）在 projdeck 里的接口，与网页的 CcSwitchPage 相同。

class CcProvider {
  final String id;
  final String name;
  final String? website;
  final String? category;
  final bool current;
  CcProvider.fromJson(Map<String, dynamic> j)
    : id = j['id'],
      name = j['name'] ?? '',
      website = j['website'],
      category = j['category'],
      current = j['current'] == true;
}

class CcApp {
  final String app;
  final String label;
  final List<CcProvider> providers;
  CcApp.fromJson(Map<String, dynamic> j)
    : app = j['app'],
      label = j['label'] ?? j['app'],
      providers = [for (final p in (j['providers'] as List? ?? [])) CcProvider.fromJson(p)];

  CcProvider? get current => providers.where((p) => p.current).firstOrNull;
}

class CcStatus {
  final bool installed;
  final bool running;
  final List<CcApp> apps;
  CcStatus.fromJson(Map<String, dynamic> j)
    : installed = j['installed'] == true,
      running = j['running'] == true,
      apps = [for (final a in (j['apps'] as List? ?? [])) CcApp.fromJson(a)];
}

class CcUsageRow {
  final String name;
  final String app;
  final int requests;
  final double cost;
  final int tokens;
  final double successRate;
  final double? speed;
  final bool speedEstimated;
  final double? firstTokenMs;
  final bool firstTokenEstimated;
  CcUsageRow.fromJson(Map<String, dynamic> j)
    : name = j['name'] ?? '',
      app = j['app'] ?? '',
      requests = (j['requests'] as num).toInt(),
      cost = (j['cost'] as num).toDouble(),
      tokens = (j['tokens'] as num).toInt(),
      successRate = (j['successRate'] as num).toDouble(),
      speed = (j['speed'] as num?)?.toDouble(),
      speedEstimated = j['speedEstimated'] == true,
      firstTokenMs = (j['firstTokenMs'] as num?)?.toDouble(),
      firstTokenEstimated = j['firstTokenEstimated'] == true;
}

class CcBucket {
  final String label;
  final int requests;
  final double cost;
  final int tokens;
  CcBucket.fromJson(Map<String, dynamic> j)
    : label = j['label'],
      requests = (j['requests'] as num).toInt(),
      cost = (j['cost'] as num).toDouble(),
      tokens = (j['tokens'] as num).toInt();
}

class CcLog {
  final DateTime at;
  final String app;
  final String provider;
  final String model;
  final int input, output, cacheRead, cacheCreation;
  final double cost;
  final int status;
  final int latencyMs;
  CcLog.fromJson(Map<String, dynamic> j)
    : at = DateTime.fromMillisecondsSinceEpoch((j['at'] as num).toInt()),
      app = j['app'] ?? '',
      provider = j['provider'] ?? '',
      model = j['model'] ?? '',
      input = (j['input'] as num).toInt(),
      output = (j['output'] as num).toInt(),
      cacheRead = (j['cacheRead'] as num).toInt(),
      cacheCreation = (j['cacheCreation'] as num).toInt(),
      cost = (j['cost'] as num).toDouble(),
      status = (j['status'] as num).toInt(),
      latencyMs = (j['latencyMs'] as num).toInt();
}

class CcUsage {
  final List<({String app, String label})> apps;
  final double cost;
  final int requests;
  final int tokens;
  final double cacheHitRate;
  final double todayCost;
  final List<CcBucket> series;
  final List<CcUsageRow> models;
  final List<CcUsageRow> providers;
  final List<CcLog> logs;
  CcUsage.fromJson(Map<String, dynamic> j)
    : apps = [for (final a in (j['apps'] as List)) (app: a['app'] as String, label: a['label'] as String)],
      cost = (j['summary']['cost'] as num).toDouble(),
      requests = (j['summary']['requests'] as num).toInt(),
      tokens = (j['summary']['tokens'] as num).toInt(),
      cacheHitRate = (j['summary']['cacheHitRate'] as num).toDouble(),
      todayCost = (j['summary']['todayCost'] as num).toDouble(),
      series = [for (final b in (j['series'] as List)) CcBucket.fromJson(b)],
      models = [for (final r in (j['models'] as List)) CcUsageRow.fromJson(r)],
      providers = [for (final r in (j['providers'] as List)) CcUsageRow.fromJson(r)],
      logs = [for (final l in (j['logs'] as List)) CcLog.fromJson(l)];
}

extension CcSwitchApi on Api {
  Future<CcStatus> ccStatus() async => CcStatus.fromJson(await get('/api/ccswitch'));
  Future<({bool launched})> ccSwitch(String app, String id) async =>
      (launched: (await post('/api/ccswitch/switch', {'app': app, 'id': id}))['launched'] == true);
  Future<CcUsage> ccUsage(String range, String? app) async =>
      CcUsage.fromJson(await get('/api/ccswitch/usage?range=$range${app == null ? '' : '&app=${Uri.encodeQueryComponent(app)}'}'));
  Future<bool> ccBridgeAvailable() async => (await get('/api/ccswitch/bridge'))['available'] == true;
  Future<void> ccEnableBridge() => post('/api/ccswitch/bridge/enable');

  /// 调用电脑上 CC Switch 的命令（经调试端口转发，等同于在它界面里操作）。
  Future<dynamic> ccInvoke(String cmd, [Map<String, Object?> args = const {}]) async =>
      (await post('/api/ccswitch/invoke', {'cmd': cmd, 'args': args}))['result'];
}
