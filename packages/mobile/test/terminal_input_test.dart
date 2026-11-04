import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:projdeck/widgets/terminal_input.dart';
import 'package:xterm/xterm.dart' as xt;

class _Harness {
  final terminal = xt.Terminal();
  final controller = xt.TerminalController();
  final focus = FocusNode();
  final key = GlobalKey<TerminalInputState>();
  final output = <String>[];
}

Future<_Harness> _mount(WidgetTester tester, {bool stock = false}) async {
  final h = _Harness();
  h.terminal.onOutput = h.output.add;
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: SizedBox(
          width: 400,
          height: 240,
          child: stock
              ? xt.TerminalView(
                  h.terminal,
                  focusNode: h.focus,
                  keyboardType: TextInputType.text,
                  deleteDetection: true,
                )
              : TerminalInput(
                  key: h.key,
                  terminal: h.terminal,
                  controller: h.controller,
                  focusNode: h.focus,
                  theme: xt.TerminalThemes.defaultTheme,
                  textStyle: const xt.TerminalStyle(),
                ),
        ),
      ),
    ),
  );
  h.focus.requestFocus();
  await tester.pump();
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    h.focus.dispose();
    h.controller.dispose();
  });
  return h;
}

void _edit(WidgetTester tester, String text, {int? start, int? end}) {
  tester.testTextInput.updateEditingValue(
    TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
      composing: start == null
          ? TextRange.empty
          : TextRange(start: start, end: end ?? text.length),
    ),
  );
}

String _anchor(WidgetTester tester) =>
    tester.testTextInput.editingState!['text'] as String;

void main() {
  testWidgets('reproduces xterm 4 dropping an anchorless Chinese commit', (
    tester,
  ) async {
    final h = await _mount(tester, stock: true);
    expect(tester.testTextInput.setClientArgs!['enableSuggestions'], false);
    expect(_anchor(tester), '  ');
    _edit(tester, '中文');
    await tester.pump();
    expect(h.output.join(), ''); // xterm unconditionally removes two characters
  });

  testWidgets(
    'IME remains a writable text field with Chinese candidates enabled',
    (tester) async {
      await _mount(tester);
      final config = tester.testTextInput.setClientArgs!;
      expect(config['inputType'], TextInputType.text.toJson());
      expect(config['enableSuggestions'], true);
      expect(config['autocorrect'], false);
      expect(config['obscureText'], false);
      expect(tester.testTextInput.isVisible, true);
    },
  );

  testWidgets('commits Chinese intact with or without the deletion anchor', (
    tester,
  ) async {
    final h = await _mount(tester);
    final anchor = _anchor(tester);
    _edit(tester, '中文');
    _edit(tester, '你');
    _edit(tester, '$anchor输入法');
    _edit(tester, '$anchor hello 世界 😀');
    await tester.pump();
    expect(h.output, ['中文', '你', '输入法', ' hello 世界 😀']);
    expect(_anchor(tester), anchor);
    expect(h.key.currentState!.currentTextEditingValue.text, anchor);
  });

  testWidgets(
    'pinyin stays local until commit, including composition backspace',
    (tester) async {
      final h = await _mount(tester);
      final anchor = _anchor(tester);
      _edit(tester, '${anchor}n', start: anchor.length);
      _edit(tester, '${anchor}ni', start: anchor.length);
      await tester.pump();
      expect(find.text('ni'), findsOneWidget);
      _edit(tester, '${anchor}n', start: anchor.length);
      expect(h.output, isEmpty);
      _edit(tester, '$anchor你');
      await tester.pump();
      expect(h.output, ['你']);
      expect(find.text('ni'), findsNothing);
      _edit(tester, anchor); // repeated reset/selection updates must not resend
      expect(h.output, ['你']);
    },
  );

  testWidgets(
    'cancelled or fully deleted composition does not erase shell text',
    (tester) async {
      final h = await _mount(tester);
      final anchor = _anchor(tester);
      _edit(tester, '${anchor}ni', start: anchor.length);
      _edit(tester, '');
      _edit(tester, '${anchor}hao', start: anchor.length);
      _edit(tester, anchor);
      await tester.pump();
      expect(h.output, isEmpty);
    },
  );

  testWidgets(
    'partial commit plus a new composing word is delivered exactly once',
    (tester) async {
      final h = await _mount(tester);
      final anchor = _anchor(tester);
      _edit(tester, '${anchor}ni', start: anchor.length);
      _edit(tester, '$anchor你hao', start: anchor.length + 1);
      expect(h.output, ['你']);
      _edit(tester, '$anchor你ha', start: anchor.length + 1);
      expect(h.output, ['你']);
      _edit(tester, '$anchor你好');
      await tester.pump();
      expect(h.output, ['你', '好']);
    },
  );

  testWidgets('anchorless composition and non-BMP commits are not truncated', (
    tester,
  ) async {
    final h = await _mount(tester);
    _edit(tester, 'zhong', start: 0);
    _edit(tester, '中文😀');
    await tester.pump();
    expect(h.output, ['中文😀']);
  });

  testWidgets(
    'soft backspace and both soft Enter paths use terminal control codes',
    (tester) async {
      final h = await _mount(tester);
      final anchor = _anchor(tester);
      _edit(tester, '');
      _edit(tester, '${anchor}a');
      _edit(tester, '');
      await tester.testTextInput.receiveAction(TextInputAction.newline);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      _edit(tester, '$anchor\n');
      await tester.pump();
      expect(h.output, ['\x7f', 'a', '\x7f', '\r', '\r', '\r']);
    },
  );

  testWidgets(
    'candidate confirmation and hardware pinyin are not swallowed by xterm',
    (tester) async {
      final h = await _mount(tester);
      final anchor = _anchor(tester);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyN, character: 'n');
      expect(
        h.output,
        isEmpty,
      ); // printable hardware input must reach platform IME
      _edit(tester, '${anchor}ni', start: anchor.length);
      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.testTextInput.receiveAction(TextInputAction.newline);
      expect(h.output, isEmpty);
      _edit(tester, '$anchor你');
      await tester.pump();
      expect(h.output, ['你']);
    },
  );

  testWidgets(
    'hardware terminal keys, Ctrl-C and the terminal key bar still work',
    (tester) async {
      final h = await _mount(tester);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowUp);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyC, character: 'c');
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      // KeyBar calls the same terminal API directly; it bypasses the IME.
      h.terminal.keyInput(xt.TerminalKey.arrowLeft);
      h.terminal.keyInput(xt.TerminalKey.keyC, ctrl: true);
      await tester.pump();
      expect(h.output, [
        '\x1b[A',
        '\t',
        '\x1b',
        '\x7f',
        '\r',
        '\x03',
        '\x1b[D',
        '\x03',
      ]);
    },
  );

  testWidgets(
    'focus loss resets composition and tapping can reopen a closed client',
    (tester) async {
      final h = await _mount(tester);
      final anchor = _anchor(tester);
      _edit(tester, '${anchor}ni', start: anchor.length);
      h.focus.unfocus();
      await tester.pump();
      expect(h.output, isEmpty);
      h.key.currentState!.requestKeyboard();
      await tester.pump();
      expect(h.key.currentState!.currentTextEditingValue.text, anchor);
      _edit(tester, '$anchor中文');
      expect(h.output, ['中文']);
      h.key.currentState!.connectionClosed();
      h.key.currentState!.requestKeyboard();
      await tester.pump();
      _edit(tester, '恢复');
      expect(h.output, ['中文', '恢复']);
    },
  );
}
