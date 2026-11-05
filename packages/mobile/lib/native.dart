import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'api/client.dart';

/// 安卓原生部分（MainActivity.kt）：后台通知的开关，点通知打开的页面。
class Native {
  static const _ch = MethodChannel('projdeck/native');

  static Future<bool> notificationsEnabled() async => await _ch.invokeMethod<bool>('notificationsEnabled') ?? false;

  /// 开启时会请求通知权限；返回是否成功。
  static Future<bool> setNotifications(bool on, Connection conn) async =>
      await _ch.invokeMethod<bool>('setNotifications', {'on': on, 'base': conn.base.toString().replaceAll(RegExp(r'/$'), ''), 'key': conn.key}) ??
      false;

  /// 打开同源 /harness/ 原版网页；主密钥仅由原生层写入 Cookie。
  /// [full] 为 true 时打开完整原版（含侧栏），否则打开只含聊天的嵌入模式。
  static Future<void> openHarnessWeb(Connection conn, {bool full = false}) =>
      _ch.invokeMethod<void>('openHarnessWeb', {'base': conn.base.toString(), 'key': conn.key, 'full': full});

  /// 点通知启动 App 时要打开的页面（如 `/#/s/<paneId>`）。
  static Future<String?> initialPath() => _ch.invokeMethod<String>('initialPath');

  /// 剪贴板里的图片或文件（例如截图后「复制」、相册里「复制」）；没有时为 null。
  static Future<LocalFile?> clipboardFile() async {
    final r = await _ch.invokeMapMethod<String, Object?>('clipboardFile');
    if (r == null) return null;
    return LocalFile.bytes(r['name'] as String, r['bytes'] as Uint8List, mime: r['mime'] as String);
  }

  /// 用系统的下载管理器下载普通文件（带上访问 key），保存到「下载」文件夹。
  static Future<void> download(Uri url, String name, Connection conn) =>
      _ch.invokeMethod('download', {'url': url.toString(), 'name': name, 'cookie': conn.headers['Cookie']});

  /// App 内更新：原生下载安装包并直接拉起系统安装器，进度写入 [updateProgress]，
  /// 失败写入 [updateError]。不再让用户去通知栏找下载完成的文件。
  static final updateProgress = ValueNotifier<int?>(null);
  static final updateError = ValueNotifier<String?>(null);

  static Future<void> downloadAndInstallUpdate(Uri url, Connection conn) async {
    updateProgress.value = 0;
    updateError.value = null;
    await _ch.invokeMethod('downloadAndInstall', {'url': url.toString(), 'cookie': conn.headers['Cookie']});
  }

  // ---- 远程调试（App 里的 adb 客户端，见 docs/REMOTE_ADB.md） ----

  static Future<Map<String, dynamic>> adbStatus() async => Map<String, dynamic>.from(await _ch.invokeMapMethod<String, Object?>('adbStatus') ?? {});

  /// 开始配对：配对码在通知里输入。
  static Future<void> adbStartPairing() => _ch.invokeMethod('adbStartPairing');

  /// 开关远程调试的转发：开了之后 App 在后台连着服务器，并自动保持 adb 的 TCP 模式。
  static Future<void> adbRelaySet(bool on, Connection conn) =>
      _ch.invokeMethod('adbRelaySet', {'on': on, 'base': conn.base.toString().replaceAll(RegExp(r'/$'), ''), 'key': conn.key});

  /// 这个 App 自己的版本号和 build 号（和服务器上发布的新版本比较）。
  static Future<Map<String, dynamic>> appVersion() async =>
      (await _ch.invokeMethod<Map>('appVersion'))?.cast<String, dynamic>() ?? const {};

  /// 打开系统的「自启动管理」（手机重启、App 更新后让远程连接自己恢复）。
  static Future<bool> openAutostartSettings() async => await _ch.invokeMethod<bool>('openAutostartSettings') ?? false;

  /// 请系统把本 App 从电池优化里排除（否则息屏后后台连接容易被掐掉）。
  static Future<bool> requestUnrestrictedBattery() async => await _ch.invokeMethod<bool>('requestUnrestrictedBattery') ?? false;

  /// 打开系统的开发者选项（定位到「无线调试」）。
  static Future<bool> openDeveloperSettings() async => await _ch.invokeMethod<bool>('openDeveloperSettings') ?? false;

  /// 打开系统的「无障碍」设置（打开配对助手）。
  static Future<void> openAccessibilitySettings() => _ch.invokeMethod('openAccessibilitySettings');

  /// 给 App 自己授权（需要已配对、无线调试开着）。返回结果说明；失败抛出 PlatformException。
  static Future<String> adbGrantSelf() async => await _ch.invokeMethod<String>('adbGrantSelf') ?? '';

  /// 把 adb 切到 TCP 模式（5555）。
  static Future<String> adbEnableTcp() async => await _ch.invokeMethod<String>('adbEnableTcp') ?? '';

  /// 启动 App 时带的访问链接（用 adb 安装后直接登录）。
  static Future<String?> initialLink() => _ch.invokeMethod<String>('initialLink');

  /// App 已在运行时点通知。
  static void onOpen(void Function(String path) handler) {
    _ch.setMethodCallHandler((call) async {
      if (call.method == 'open') handler(call.arguments as String);
      if (call.method == 'updateProgress') updateProgress.value = (call.arguments as num?)?.toInt();
      if (call.method == 'updateError') updateError.value = call.arguments as String?;
    });
  }
}
