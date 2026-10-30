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

  /// 点通知启动 App 时要打开的页面（如 `/#/s/<paneId>`）。
  static Future<String?> initialPath() => _ch.invokeMethod<String>('initialPath');

  /// 剪贴板里的图片或文件（例如截图后「复制」、相册里「复制」）；没有时为 null。
  static Future<LocalFile?> clipboardFile() async {
    final r = await _ch.invokeMapMethod<String, Object?>('clipboardFile');
    if (r == null) return null;
    return LocalFile.bytes(r['name'] as String, r['bytes'] as Uint8List, mime: r['mime'] as String);
  }

  /// 用系统的下载管理器下载（带上访问 key），保存到「下载」文件夹。
  static Future<void> download(Uri url, String name, Connection conn) =>
      _ch.invokeMethod('download', {'url': url.toString(), 'name': name, 'cookie': conn.headers['Cookie']});

  /// 启动 App 时带的访问链接（用 adb 安装后直接登录）。
  static Future<String?> initialLink() => _ch.invokeMethod<String>('initialLink');

  /// App 已在运行时点通知。
  static void onOpen(void Function(String path) handler) {
    _ch.setMethodCallHandler((call) async {
      if (call.method == 'open') handler(call.arguments as String);
    });
  }
}
