import 'dart:async';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../native.dart';
import '../theme.dart';
import 'common.dart';

/// App 内更新：下载进度在对话框里显示，完成后原生直接拉起系统安装器。
/// 失败时把原因带回，不会静默停在 0%。
Future<void> installAppUpdate(BuildContext context, Connection conn) async {
  final done = Completer<String?>();
  if (!context.mounted) return;
  unawaited(showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _UpdateDialog(done: (error) { if (!done.isCompleted) done.complete(error); }),
  ));
  try {
    await Native.downloadAndInstallUpdate(Uri.parse('${conn.base}/app/projdeck.apk'), conn);
  } catch (e) {
    if (!done.isCompleted) done.complete(e.toString());
  }
  final error = await done.future;
  if (!context.mounted) return;
  if (error != null) toast(context, '更新失败：$error', error: true);
}

class _UpdateDialog extends StatefulWidget {
  final void Function(String? error) done;
  const _UpdateDialog({required this.done});

  @override
  State<_UpdateDialog> createState() => _UpdateDialogState();
}

class _UpdateDialogState extends State<_UpdateDialog> {
  int? _progress;
  bool _closed = false;

  @override
  void initState() {
    super.initState();
    Native.updateProgress.addListener(_changed);
    Native.updateError.addListener(_changed);
    _progress = Native.updateProgress.value;
  }

  void _changed() {
    if (!mounted || _closed) return;
    final error = Native.updateError.value;
    final progress = Native.updateProgress.value;
    if (error != null) return _finish(error);
    if (progress != null) setState(() => _progress = progress);
    if (progress != null && progress >= 100) _finish(null);
  }

  void _finish(String? error) {
    if (_closed) return;
    _closed = true;
    Navigator.of(context).pop();
    widget.done(error);
  }

  @override
  void dispose() {
    Native.updateProgress.removeListener(_changed);
    Native.updateError.removeListener(_changed);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final value = _progress;
    return AlertDialog(
      title: const Text('正在更新 projdeck'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          LinearProgressIndicator(value: value == null || value <= 0 ? null : value / 100),
          const SizedBox(height: 12),
          Text(value == null || value <= 0 ? '正在连接电脑…' : '已下载 $value%，完成后会自动打开安装界面', style: TextStyle(fontSize: 13, color: p.mutedFg)),
        ],
      ),
    );
  }
}
