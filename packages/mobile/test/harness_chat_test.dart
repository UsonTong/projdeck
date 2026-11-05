import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:projdeck/api/client.dart';
import 'package:projdeck/api/models.dart';
import 'package:projdeck/widgets/harness_chat.dart';

void main() {
  test(
    'embed receives the exact upstream conversation ID, not the pane namespace',
    () {
      final session = Session.fromJson({
        'paneId': 'harness:projdeck-alias',
        'kind': 'harness',
        'conversationId': 'original:session/with?reserved=字符',
        'capabilities': {'terminal': true, 'chat': true, 'keys': true},
      });
      expect(harnessSessionId(session), 'original:session/with?reserved=字符');
      expect(session.supportsTerminal, false);
      expect(session.supportsKeys, false);
    },
  );

  test('legacy IDs strip only the leading projdeck namespace', () {
    expect(
      harnessSessionId(Session.fromJson({'paneId': 'harness:upstream:123'})),
      'upstream:123',
    );
    expect(
      harnessSessionId(
        Session.fromJson({'paneId': 'raw-id', 'backend': 'harness'}),
      ),
      'raw-id',
    );
  });

  testWidgets(
    'creates an Android platform view with session and private connection parameters',
    (tester) async {
      final calls = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform_views,
        (call) async {
          calls.add(call);
          if (call.method == 'create') return 1;
          if (call.method == 'resize') {
            final args = call.arguments as Map;
            return {'width': args['width'], 'height': args['height']};
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform_views,
          null,
        ),
      );
      final connection = Connection(
        Uri.parse('https://projdeck.example:8443'),
        'private-master-key',
      );
      await tester.pumpWidget(
        MaterialApp(
          home: SizedBox(
            width: 400,
            height: 600,
            child: HarnessChat(
              connection: connection,
              sessionId: 'original:chat?one=1',
              prepare: () async {},
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      final view = tester.widget<AndroidView>(find.byType(AndroidView));
      expect(view.viewType, 'projdeck/harness');
      expect(view.creationParams, {
        'base': 'https://projdeck.example:8443',
        'key': 'private-master-key',
        'sessionId': 'original:chat?one=1',
      });
      expect(view.creationParamsCodec, isA<StandardMessageCodec>());
      expect(view.gestureRecognizers, isNotEmpty);
      expect(calls.where((call) => call.method == 'create'), hasLength(1));
      // No Activity launch, credential URL, method channel, or JavaScript bridge.
      expect((view.creationParams as Map).containsKey('url'), false);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      expect(calls.any((call) => call.method == 'dispose'), true);
    },
  );
}
