import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../state.dart';

/// Prefer the upstream conversation ID; older overviews encode it in paneId.
String harnessSessionId(Session session) {
  if (session.conversationId?.isNotEmpty == true) {
    return session.conversationId!;
  }
  const prefix = 'harness:';
  return session.paneId.startsWith(prefix)
      ? session.paneId.substring(prefix.length)
      : session.paneId;
}

/// Original Harness chat inside SessionPage. The saved session is first joined
/// to the Harness workspace matching its directory, so the upstream composer
/// never asks to choose a workspace again.
class HarnessChat extends StatefulWidget {
  const HarnessChat({
    super.key,
    required this.connection,
    required this.sessionId,
    this.prepare,
  });

  final Connection connection;
  final String sessionId;
  /// 测试或特殊入口可以跳过工作区预绑定。
  final Future<void> Function()? prepare;

  @override
  State<HarnessChat> createState() => _HarnessChatState();
}

class _HarnessChatState extends State<HarnessChat> {
  bool _prepared = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final prepare = widget.prepare ?? () => AppScope.read(context).api.bindHarness(widget.sessionId);
      prepare().catchError((_) {}).whenComplete(() {
        if (mounted) setState(() => _prepared = true);
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    if (defaultTargetPlatform != TargetPlatform.android || kIsWeb) {
      return const Center(child: Text('原版 Harness 内嵌聊天需要 Android 系统 WebView'));
    }
    if (!_prepared) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    return AndroidView(
      // A different connection or session must get a fresh native view.
      key: ValueKey((widget.connection, widget.sessionId)),
      viewType: 'projdeck/harness',
      creationParams: {
        'base': widget.connection.base.toString(),
        'key': widget.connection.key,
        'sessionId': widget.sessionId,
      },
      creationParamsCodec: const StandardMessageCodec(),
      layoutDirection: TextDirection.ltr,
      gestureRecognizers: {
        Factory<OneSequenceGestureRecognizer>(() => EagerGestureRecognizer()),
      },
    );
  }
}
