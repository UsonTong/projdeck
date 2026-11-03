import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../api/client.dart';
import '../native.dart';
import '../theme.dart';
import 'common.dart';

enum _Source { media, files, clipboard }

Future<List<LocalFile>> _picked(List<PlatformFile> files) async => [for (final f in files) await _local(f)];

Future<LocalFile> _local(PlatformFile f) async {
  final length = await f.length() ?? 0;
  final local = LocalFile(name: f.name, length: length, open: () => f.readAsByteStream());
  // 图片读进内存，用来显示缩略图
  return local.isImage && length < 20 * 1024 * 1024 ? LocalFile.bytes(f.name, await f.readAsBytes(), mime: local.mime) : local;
}

/// 添加附件：相册里的图片 / 视频、手机里的文件、剪贴板里的图片或文件。取消时返回空列表。
Future<List<LocalFile>> pickAttachments(BuildContext context) async {
  final p = Palette.of(context);
  final source = await showModalBottomSheet<_Source>(
    context: context,
    useSafeArea: true,
    builder: (ctx) => Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (s, icon, label) in [
            (_Source.media, Icons.photo_library_outlined, '相册里的图片 / 视频'),
            (_Source.files, Icons.attach_file_rounded, '手机里的文件'),
            (_Source.clipboard, Icons.content_paste_rounded, '粘贴剪贴板里的图片 / 文件'),
          ])
            ListTile(
              leading: Icon(icon, color: p.fg),
              title: Text(label),
              onTap: () => Navigator.pop(ctx, s),
            ),
        ],
      ),
    ),
  );
  switch (source) {
    case null:
      return const [];
    case _Source.media:
      return _picked(await FilePicker.pickFiles(type: FileType.media));
    case _Source.files:
      return _picked(await FilePicker.pickFiles());
    case _Source.clipboard:
      final f = await Native.clipboardFile();
      if (f == null && context.mounted) toast(context, '剪贴板里没有图片或文件（先在相册或截图里点「复制」）');
      return f == null ? const [] : [f];
  }
}
