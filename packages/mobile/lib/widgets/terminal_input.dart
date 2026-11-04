import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart' as xt;

/// xterm 4's text client disables Android IME suggestions and assumes every
/// commit retains its two-space deletion buffer. Keep xterm's renderer/keymap,
/// but own the text connection so Chinese IMEs can compose and commit normally.
class TerminalInput extends StatefulWidget {
  const TerminalInput({
    super.key,
    required this.terminal,
    required this.controller,
    required this.focusNode,
    required this.theme,
    required this.textStyle,
    this.padding = EdgeInsets.zero,
    this.keyboardAppearance = Brightness.dark,
  });

  final xt.Terminal terminal;
  final xt.TerminalController controller;
  final FocusNode focusNode;
  final xt.TerminalTheme theme;
  final xt.TerminalStyle textStyle;
  final EdgeInsets padding;
  final Brightness keyboardAppearance;

  @override
  State<TerminalInput> createState() => TerminalInputState();
}

class TerminalInputState extends State<TerminalInput> with TextInputClient {
  // A non-printing anchor lets IMEs report backspace even at an empty prompt.
  // Unlike xterm's fixed substring(2), the anchor is stripped only if present.
  static const _anchor = '\u{200b}';
  static const _empty = TextEditingValue(
    text: _anchor,
    selection: TextSelection.collapsed(offset: 1),
  );
  final _viewKey = GlobalKey<xt.TerminalViewState>();
  TextInputConnection? _connection;
  TextEditingValue _value = _empty;
  String _committed = '';
  String? _composing;

  TextInputConfiguration get _configuration => TextInputConfiguration(
    inputType: TextInputType.text,
    inputAction: TextInputAction.newline,
    keyboardAppearance: widget.keyboardAppearance,
    autocorrect: false,
    // false sets Android TYPE_TEXT_FLAG_NO_SUGGESTIONS, which some Chinese
    // keyboards interpret as a Latin-only field. Composition needs candidates.
    enableSuggestions: true,
    enableIMEPersonalizedLearning: false,
  );

  @override
  void initState() {
    super.initState();
    widget.focusNode.addListener(_focusChanged);
    if (widget.focusNode.hasFocus) _openConnection();
  }

  @override
  void didUpdateWidget(TerminalInput oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.focusNode != widget.focusNode) {
      oldWidget.focusNode.removeListener(_focusChanged);
      widget.focusNode.addListener(_focusChanged);
      _closeConnection();
      _focusChanged();
    } else if (oldWidget.keyboardAppearance != widget.keyboardAppearance) {
      _connection?.updateConfig(_configuration);
    }
  }

  void requestKeyboard() {
    if (widget.focusNode.hasFocus) {
      _openConnection();
    } else {
      widget.focusNode.requestFocus();
    }
  }

  void _focusChanged() {
    if (widget.focusNode.hasFocus) {
      _openConnection();
    } else {
      _closeConnection();
      if (mounted) setState(() {});
    }
  }

  void _openConnection() {
    if (_connection?.attached != true) {
      _value = _empty;
      _committed = '';
      _composing = null;
      _connection = TextInput.attach(this, _configuration);
      _connection!.setEditingState(_value);
    }
    _connection!.show();
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateCaret());
  }

  void _closeConnection() {
    _connection?.close();
    _connection = null;
    _value = _empty;
    _committed = '';
    _composing = null;
  }

  void _updateCaret() {
    if (!mounted || _connection?.attached != true) return;
    final view = _viewKey.currentState;
    if (view == null) return;
    final rect = view.globalCursorRect;
    _connection!.setEditableSizeAndTransform(
      rect.size,
      Matrix4.translationValues(rect.left, rect.top, 0),
    );
    _connection!.setCaretRect(Offset.zero & rect.size);
  }

  KeyEventResult _onKeyEvent(FocusNode node, KeyEvent event) {
    if (_composing != null) return KeyEventResult.skipRemainingHandlers;
    final keyboard = HardwareKeyboard.instance;
    if (event.character?.isNotEmpty == true &&
        !keyboard.isControlPressed &&
        !keyboard.isAltPressed &&
        !keyboard.isMetaPressed &&
        event.logicalKey != LogicalKeyboardKey.enter &&
        event.logicalKey != LogicalKeyboardKey.numpadEnter &&
        event.logicalKey != LogicalKeyboardKey.backspace &&
        event.logicalKey != LogicalKeyboardKey.tab &&
        event.logicalKey != LogicalKeyboardKey.escape) {
      // Let the platform IME consume printable keys, including the first
      // pinyin key before it has reported a composing range. xterm's hardware
      // listener would otherwise insert/consume event.character immediately.
      return KeyEventResult.skipRemainingHandlers;
    }
    return KeyEventResult.ignored; // xterm still handles Ctrl, arrows, etc.
  }

  @override
  void updateEditingValue(TextEditingValue value) {
    if (value == _value) return;
    final wasComposing = _composing != null;
    _value = value;
    final anchorLength = value.text.startsWith(_anchor) ? _anchor.length : 0;
    final composing = value.composing;
    if (composing.isValid &&
        !composing.isCollapsed &&
        composing.end <= value.text.length) {
      // An IME may commit one word and start the next composition in the same
      // update. Send only the committed prefix, without resetting its buffer.
      final end = composing.start < anchorLength
          ? anchorLength
          : composing.start;
      _emitCommitted(value.text.substring(anchorLength, end));
      setState(() => _composing = composing.textInside(value.text));
    } else {
      final text = value.text.substring(anchorLength);
      if (!wasComposing && _committed.isEmpty && value.text.isEmpty) {
        widget.terminal.keyInput(xt.TerminalKey.backspace);
      } else {
        _emitCommitted(text);
      }
      _value = _empty;
      _committed = '';
      setState(() => _composing = null);
      if (value != _empty) _connection?.setEditingState(_empty);
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateCaret());
  }

  void _emitCommitted(String text) {
    final old = _committed.characters.toList();
    final next = text.characters.toList();
    var common = 0;
    while (common < old.length &&
        common < next.length &&
        old[common] == next[common]) {
      common++;
    }
    for (var i = common; i < old.length; i++) {
      widget.terminal.keyInput(xt.TerminalKey.backspace);
    }
    final added = next.skip(common).join();
    if (added.isNotEmpty) {
      widget.terminal.textInput(added.replaceAll(RegExp(r'\r\n|\r|\n'), '\r'));
    }
    _committed = text;
  }

  @override
  TextEditingValue get currentTextEditingValue => _value;

  @override
  AutofillScope? get currentAutofillScope => null;

  @override
  void performAction(TextInputAction action) {
    if (_composing != null) return; // candidate confirmation is not shell Enter
    if (action == TextInputAction.done || action == TextInputAction.newline) {
      widget.terminal.keyInput(xt.TerminalKey.enter);
    }
  }

  @override
  void connectionClosed() {
    _connection = null;
    _value = _empty;
    _committed = '';
    if (mounted) setState(() => _composing = null);
  }

  @override
  void updateFloatingCursor(RawFloatingCursorPoint point) {}
  @override
  void showAutocorrectionPromptRect(int start, int end) {}
  @override
  void performPrivateCommand(String action, Map<String, dynamic> data) {}
  @override
  void insertTextPlaceholder(Size size) {}
  @override
  void removeTextPlaceholder() {}
  @override
  void showToolbar() {}

  @override
  Widget build(BuildContext context) {
    final caret = _viewKey.currentState?.cursorRect ?? Rect.zero;
    return Stack(
      fit: StackFit.passthrough,
      children: [
        xt.TerminalView(
          widget.terminal,
          key: _viewKey,
          controller: widget.controller,
          focusNode: widget.focusNode,
          theme: widget.theme,
          textStyle: widget.textStyle,
          padding: widget.padding,
          // This disables only xterm's broken text client. The connection above
          // remains a normal, writable IME client; xterm keeps its keymap.
          hardwareKeyboardOnly: true,
          onKeyEvent: _onKeyEvent,
        ),
        if (_composing != null && _composing!.isNotEmpty)
          Positioned(
            left: caret.left + widget.padding.left,
            top: caret.top + widget.padding.top,
            child: IgnorePointer(
              child: Text(
                _composing!,
                style: TextStyle(
                  fontFamily: widget.textStyle.fontFamily,
                  fontSize: widget.textStyle.fontSize,
                  color: widget.theme.foreground,
                  backgroundColor: widget.theme.background,
                  decoration: TextDecoration.underline,
                ),
              ),
            ),
          ),
      ],
    );
  }

  @override
  void dispose() {
    widget.focusNode.removeListener(_focusChanged);
    _closeConnection();
    super.dispose();
  }
}
