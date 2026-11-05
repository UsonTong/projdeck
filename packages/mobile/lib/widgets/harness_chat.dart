import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';

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

/// Original Harness chat inside SessionPage, authenticated only by the native
/// HttpOnly cookie. Session choice travels by URL; no JS bridge is exposed.
class HarnessChat extends StatelessWidget {
  const HarnessChat({
    super.key,
    required this.connection,
    required this.sessionId,
  });

  final Connection connection;
  final String sessionId;

  @override
  Widget build(BuildContext context) {
    if (defaultTargetPlatform != TargetPlatform.android || kIsWeb) {
      return const Center(child: Text('原版 Harness 内嵌聊天需要 Android 系统 WebView'));
    }
    return AndroidView(
      // A different connection or session must get a fresh native view.
      key: ValueKey((connection, sessionId)),
      viewType: 'projdeck/harness',
      creationParams: {
        'base': connection.base.toString(),
        'key': connection.key,
        'sessionId': sessionId,
      },
      creationParamsCodec: const StandardMessageCodec(),
      layoutDirection: TextDirection.ltr,
      gestureRecognizers: {
        Factory<OneSequenceGestureRecognizer>(() => EagerGestureRecognizer()),
      },
    );
  }
}
