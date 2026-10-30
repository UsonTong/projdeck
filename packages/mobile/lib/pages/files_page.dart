import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../native.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/attach.dart';
import '../widgets/common.dart';
import '../widgets/image_viewer.dart';

const _imageExt = {'png', 'jpg', 'jpeg', 'gif', 'webp'};

String _ext(String name) => name.contains('.') ? name.split('.').last.toLowerCase() : '';

String _size(int b) {
  if (b < 1024) return '$b B';
  if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(b < 10240 ? 1 : 0)} KB';
  if (b < 1024 * 1024 * 1024) return '${(b / 1024 / 1024).toStringAsFixed(1)} MB';
  return '${(b / 1024 / 1024 / 1024).toStringAsFixed(1)} GB';
}

String _time(String iso) {
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return '';
  final now = DateTime.now();
  String two(int n) => n.toString().padLeft(2, '0');
  if (t.year == now.year && t.month == now.month && t.day == now.day) return '今天 ${two(t.hour)}:${two(t.minute)}';
  if (t.year == now.year) return '${t.month}月${t.day}日';
  return '${t.year}/${t.month}/${t.day}';
}

IconData _icon(FileEntry e) {
  if (e.dir) return Icons.folder_rounded;
  final x = _ext(e.name);
  if (_imageExt.contains(x) || x == 'svg') return Icons.image_outlined;
  if ({'md', 'txt', 'rst'}.contains(x)) return Icons.article_outlined;
  if ({'zip', 'tar', 'gz', 'tgz', 'xz', '7z', 'rar'}.contains(x)) return Icons.folder_zip_outlined;
  if ({'pdf'}.contains(x)) return Icons.picture_as_pdf_outlined;
  if ({'mp3', 'wav', 'flac', 'm4a', 'ogg'}.contains(x)) return Icons.audio_file_outlined;
  if ({'mp4', 'mov', 'mkv', 'webm'}.contains(x)) return Icons.video_file_outlined;
  return Icons.description_outlined;
}

/// 项目的文件管理器：一层一层点进文件夹；点文件看图片、看 / 改文字；长按重命名、删除、下载。
class FilesPage extends StatefulWidget {
  final Project project;
  final String path;
  const FilesPage({super.key, required this.project, this.path = ''});

  static void open(BuildContext context, Project project, [String path = '']) => Navigator.of(context).push(
    MaterialPageRoute(
      builder: (_) => FilesPage(project: project, path: path),
    ),
  );

  @override
  State<FilesPage> createState() => _FilesPageState();
}

class _FilesPageState extends State<FilesPage> {
  List<FileEntry>? _entries;
  String? _error;
  bool _hidden = false;
  int _uploading = 0;

  String _child(String name) => widget.path.isEmpty ? name : '${widget.path}/$name';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await AppScope.read(context).api.listDir(widget.project.id, widget.path, hidden: _hidden);
      if (mounted) {
        setState(() {
          _entries = r;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  void _open(FileEntry e) {
    final path = _child(e.name);
    if (e.dir) {
      FilesPage.open(context, widget.project, path);
    } else if (_imageExt.contains(_ext(e.name))) {
      final app = AppScope.read(context);
      ImageViewer.open(
        context,
        NetworkImage(app.api.rawUrl(widget.project.id, path).toString(), headers: app.conn.headers),
        title: e.name,
        actions: [IconButton(icon: const Icon(Icons.download_rounded), onPressed: () => _download(e))],
      );
    } else {
      Navigator.of(context)
          .push(
            MaterialPageRoute(
              builder: (_) => TextFilePage(project: widget.project, path: path),
            ),
          )
          .then((_) => _load());
    }
  }

  Future<void> _download(FileEntry e) async {
    final app = AppScope.read(context);
    await run(
      context,
      () => Native.download(app.api.downloadUrl(widget.project.id, _child(e.name)), e.name, app.conn),
      success: '开始下载 ${e.name}，保存在「下载」文件夹',
    );
  }

  void _menu(FileEntry e) {
    final app = AppScope.read(context);
    final path = _child(e.name);
    showActions(
      context,
      title: e.name,
      subtitle: path,
      actions: [
        if (!e.dir) SheetAction(Icons.download_rounded, '下载到手机', () => _download(e)),
        SheetAction(Icons.copy_rounded, '复制路径', () {
          Clipboard.setData(ClipboardData(text: '${widget.project.path}/$path'));
          toast(context, '已复制');
        }),
        SheetAction(Icons.drive_file_rename_outline_rounded, '重命名', () async {
          final name = await promptText(context, title: '重命名', initial: e.name);
          if (name == null || name.isEmpty || name == e.name || !mounted) return;
          await run(context, () => app.api.renameFile(widget.project.id, path, name));
          _load();
        }),
        SheetAction(Icons.delete_outline_rounded, '删除', () async {
          if (!await confirm(context, title: '删除「${e.name}」？', body: e.dir ? '文件夹里的所有内容都会被删除，无法恢复。' : '删除后无法恢复。', action: '删除', destructive: true)) {
            return;
          }
          if (!mounted) return;
          await run(context, () => app.api.deleteFile(widget.project.id, path));
          _load();
        }, destructive: true),
      ],
    );
  }

  Future<void> _upload() async {
    final files = await pickAttachments(context);
    if (files.isEmpty || !mounted) return;
    setState(() => _uploading = files.length);
    await run(context, () => AppScope.read(context).api.uploadToDir(widget.project.id, widget.path, files), success: '已上传 ${files.length} 个文件');
    if (!mounted) return;
    setState(() => _uploading = 0);
    _load();
  }

  Future<void> _mkdir() async {
    final name = await promptText(context, title: '新建文件夹', hint: '文件夹名');
    if (name == null || name.isEmpty || !mounted) return;
    await run(context, () => AppScope.read(context).api.mkdir(widget.project.id, widget.path, name));
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final title = widget.path.isEmpty ? (widget.project.note ?? widget.project.name) : widget.path.split('/').last;
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            Text(
              shortPath(widget.path.isEmpty ? widget.project.path : '${widget.project.path}/${widget.path}'),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11, color: p.mutedFg, fontFamily: mono),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: _hidden ? '不显示隐藏文件' : '显示隐藏文件',
            icon: Icon(_hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined, size: 20),
            onPressed: () {
              setState(() => _hidden = !_hidden);
              _load();
            },
          ),
          IconButton(tooltip: '新建文件夹', icon: const Icon(Icons.create_new_folder_outlined, size: 22), onPressed: _mkdir),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _uploading > 0 ? null : _upload,
        icon: _uploading > 0
            ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
            : const Icon(Icons.upload_rounded),
        label: Text(_uploading > 0 ? '正在上传…' : '上传'),
      ),
      body: _error != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(_error!, style: TextStyle(color: p.mutedFg)),
              ),
            )
          : _entries == null
          ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
          : RefreshIndicator(
              onRefresh: _load,
              child: _entries!.isEmpty
                  ? ListView(
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 80),
                          child: Center(
                            child: Text('空文件夹', style: TextStyle(color: p.mutedFg)),
                          ),
                        ),
                      ],
                    )
                  : ListView.builder(
                      padding: const EdgeInsets.only(bottom: 96),
                      itemCount: _entries!.length,
                      itemBuilder: (context, i) {
                        final e = _entries![i];
                        return ListTile(
                          leading: Icon(_icon(e), color: e.dir ? p.folder : p.mutedFg),
                          title: Text(e.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                          subtitle: Text(
                            [if (!e.dir) _size(e.size), _time(e.modifiedAt)].join(' · '),
                            style: TextStyle(fontSize: 12, color: p.mutedFg),
                          ),
                          trailing: e.dir ? Icon(Icons.chevron_right_rounded, color: p.mutedFg) : null,
                          onTap: () => _open(e),
                          onLongPress: () {
                            HapticFeedback.mediumImpact();
                            _menu(e);
                          },
                        );
                      },
                    ),
            ),
    );
  }
}

/// 文字文件：查看，点「编辑」后可以修改并保存（简单修改用）。保存时检查打开之后有没有被 agent 改过。
class TextFilePage extends StatefulWidget {
  final Project project;
  final String path;
  const TextFilePage({super.key, required this.project, required this.path});

  @override
  State<TextFilePage> createState() => _TextFilePageState();
}

class _TextFilePageState extends State<TextFilePage> {
  final _ctl = TextEditingController();
  String? _error;
  bool _loading = true;
  bool _binary = false;
  bool _editing = false;
  bool _saving = false;
  int _mtime = 0;
  String _saved = '';

  bool get _dirty => _ctl.text != _saved;

  @override
  void initState() {
    super.initState();
    _ctl.addListener(() => setState(() {}));
    _load();
  }

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final api = AppScope.read(context).api;
    try {
      final r = await api.readForEdit(widget.project.id, widget.path);
      _saved = r.text;
      _ctl.text = r.text;
      _mtime = r.mtimeMs;
    } on ApiError catch (e) {
      // 不能编辑（太大或二进制）：试试只读的文字预览
      try {
        final t = await api.readText(widget.project.id, widget.path);
        if (t == null) {
          _binary = true;
        } else {
          _saved = t.text;
          _ctl.text = t.text;
          _mtime = -1;
        }
      } catch (_) {
        _error = e.message;
      }
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _save({bool force = false}) async {
    final api = AppScope.read(context).api;
    setState(() => _saving = true);
    try {
      _mtime = await api.saveFile(widget.project.id, widget.path, _ctl.text, force ? null : _mtime);
      _saved = _ctl.text;
      if (mounted) toast(context, '已保存');
    } on ApiError catch (e) {
      if (e.status == 409 && mounted) {
        final ok = await confirm(context, title: '文件在你打开之后被改过', body: '可能是 Claude / Codex 刚改了它。覆盖保存会丢掉对方的修改。', action: '覆盖保存', destructive: true);
        if (ok && mounted) {
          setState(() => _saving = false);
          return _save(force: true);
        }
      } else if (mounted) {
        toast(context, e.message, error: true);
      }
    }
    if (mounted) setState(() => _saving = false);
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final name = widget.path.split('/').last;
    final readOnly = _mtime < 0;
    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (popped, _) async {
        if (popped) return;
        if (await confirm(context, title: '放弃未保存的修改？', action: '放弃', destructive: true) && context.mounted) {
          _ctl.text = _saved;
          Navigator.pop(context);
        }
      },
      child: Scaffold(
        appBar: AppBar(
          titleSpacing: 0,
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16)),
                  ),
                  if (_dirty)
                    Padding(
                      padding: const EdgeInsets.only(left: 6),
                      child: CircleAvatar(radius: 3.5, backgroundColor: p.fg),
                    ),
                ],
              ),
              Text(
                widget.path,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11, color: p.mutedFg, fontFamily: mono),
              ),
            ],
          ),
          actions: [
            if (!_loading && !_binary && _error == null && !readOnly)
              _editing
                  ? Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: FilledButton(onPressed: _dirty && !_saving ? _save : null, child: Text(_saving ? '保存中…' : '保存')),
                    )
                  : TextButton(onPressed: () => setState(() => _editing = true), child: const Text('编辑')),
          ],
        ),
        body: _loading
            ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
            : _error != null || _binary
            ? Center(
                child: Text(_error ?? '这是二进制文件，不能预览。可以长按它下载到手机。', style: TextStyle(color: p.mutedFg)),
              )
            : Column(
                children: [
                  if (readOnly)
                    Container(
                      width: double.infinity,
                      color: p.muted,
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                      child: Text('文件太大，只显示开头的部分，不能编辑', style: TextStyle(fontSize: 12, color: p.mutedFg)),
                    ),
                  Expanded(
                    child: Scrollbar(
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.fromLTRB(14, 10, 14, 40),
                        child: TextField(
                          controller: _ctl,
                          readOnly: !_editing,
                          maxLines: null,
                          autocorrect: false,
                          enableSuggestions: false,
                          keyboardType: TextInputType.multiline,
                          style: const TextStyle(fontFamily: mono, fontSize: 13, height: 1.5),
                          decoration: const InputDecoration(
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            filled: false,
                            isCollapsed: true,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}
