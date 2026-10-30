import 'package:flutter/material.dart';
import '../theme.dart';

/// 轻提示。
void toast(BuildContext context, String text, {bool error = false}) {
  final p = Palette.of(context);
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: Text(text, style: TextStyle(color: error ? p.destructive : p.fg)),
      duration: Duration(milliseconds: error ? 4000 : 2200),
    ));
}

/// 执行一个操作，出错时提示。
Future<T?> run<T>(BuildContext context, Future<T> Function() action, {String? success}) async {
  try {
    final r = await action();
    if (success != null && context.mounted) toast(context, success);
    return r;
  } catch (e) {
    if (context.mounted) toast(context, e.toString().replaceFirst('Exception: ', ''), error: true);
    return null;
  }
}

/// 一组互斥的小选项（排序方式等）：直接点选，不用下拉菜单。
class SegmentedSwitch<T> extends StatelessWidget {
  final T value;
  final Map<T, String> options;
  final ValueChanged<T> onChanged;
  const SegmentedSwitch({super.key, required this.value, required this.options, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(color: p.muted, borderRadius: BorderRadius.circular(8)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        for (final e in options.entries)
          GestureDetector(
            onTap: () => onChanged(e.key),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 180),
              curve: Curves.easeOut,
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
              decoration: BoxDecoration(
                color: e.key == value ? p.bg : Colors.transparent,
                borderRadius: BorderRadius.circular(6),
                boxShadow: e.key == value ? [BoxShadow(color: Colors.black.withValues(alpha: 0.15), blurRadius: 2)] : null,
              ),
              child: Text(e.value, style: TextStyle(fontSize: 12, color: e.key == value ? p.fg : p.mutedFg)),
            ),
          ),
      ]),
    );
  }
}

/// 底部弹出的操作菜单（长按会话、项目时）。
class SheetAction {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool destructive;
  const SheetAction(this.icon, this.label, this.onTap, {this.destructive = false});
}

Future<void> showActions(BuildContext context, {required String title, String? subtitle, required List<SheetAction> actions}) {
  return showModalBottomSheet(
    context: context,
    useSafeArea: true,
    builder: (ctx) {
      final p = Palette.of(ctx);
      return Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              if (subtitle != null)
                Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: p.mutedFg, fontFamily: mono)),
            ]),
          ),
          for (final a in actions)
            ListTile(
              leading: Icon(a.icon, color: a.destructive ? p.destructive : p.fg),
              title: Text(a.label, style: TextStyle(color: a.destructive ? p.destructive : p.fg)),
              onTap: () {
                Navigator.pop(ctx);
                a.onTap();
              },
            ),
        ]),
      );
    },
  );
}

/// 确认对话框。
Future<bool> confirm(BuildContext context, {required String title, String? body, required String action, bool destructive = false}) async {
  final p = Palette.of(context);
  final r = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: body == null ? null : Text(body),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text('取消', style: TextStyle(color: p.mutedFg))),
        FilledButton(
          style: destructive ? FilledButton.styleFrom(backgroundColor: p.destructive, foregroundColor: p.bg) : null,
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(action),
        ),
      ],
    ),
  );
  return r == true;
}

/// 输入一行文字（重命名、备注）。返回 null 表示取消。
Future<String?> promptText(BuildContext context, {required String title, String initial = '', String? hint}) {
  final ctl = TextEditingController(text: initial)..selection = TextSelection(baseOffset: 0, extentOffset: initial.length);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(controller: ctl, autofocus: true, decoration: InputDecoration(hintText: hint), onSubmitted: (v) => Navigator.pop(ctx, v.trim())),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text.trim()), child: const Text('保存')),
      ],
    ),
  );
}

String shortPath(String path) => path.replaceFirst(RegExp(r'^/home/[^/]+'), '~');
