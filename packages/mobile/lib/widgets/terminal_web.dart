import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';

/// 用安卓 WebView 加载 projdeck 网页里的 Ghostty 终端页。
/// 和网页端是同一个 ghostty-web WASM 引擎；主密钥只由原生层写入 Cookie。
class TerminalWeb extends StatelessWidget {
  const TerminalWeb({super.key, required this.connection, required this.paneId});

  final Connection connection;
  final String paneId;

  @override
  Widget build(BuildContext context) {
    if (defaultTargetPlatform != TargetPlatform.android || kIsWeb) {
      return const Center(child: Text('Ghostty 终端需要 Android 系统 WebView'));
    }
    return AndroidView(
      key: ValueKey((connection, paneId)),
      viewType: 'projdeck/terminal',
      creationParams: {
        'base': connection.base.toString(),
        'key': connection.key,
        'paneId': paneId,
      },
      creationParamsCodec: const StandardMessageCodec(),
      layoutDirection: TextDirection.ltr,
      gestureRecognizers: {
        Factory<OneSequenceGestureRecognizer>(() => EagerGestureRecognizer()),
      },
    );
  }
}
