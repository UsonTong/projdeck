import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/client.dart';
import '../api/models.dart';
import '../native.dart';
import '../widgets/attach.dart';
import '../widgets/image_viewer.dart';
import '../sort.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/agent_icon.dart';
import '../widgets/common.dart';
import '../widgets/session_tile.dart';
import '../widgets/terminal.dart';

enum SessionView { terminal, chat }

/// 会话页：终端或对话。标题栏左右滑切到列表里的上一个 / 下一个会话。
class SessionPage extends StatefulWidget {
  final String paneId;
  const SessionPage({super.key, required this.paneId});

  @override
  State<SessionPage> createState() => _SessionPageState();
}

class _SessionPageState extends State<SessionPage> {
  final _term = GlobalKey<TerminalPaneState>();
  SessionView? _view;
  double _dragX = 0;

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      if (_view == null && mounted) setState(() => _view = p.getString('view') == 'chat' ? SessionView.chat : SessionView.terminal);
    });
  }

  void _setView(SessionView v) {
    setState(() => _view = v);
    SharedPreferences.getInstance().then((p) => p.setString('view', v.name));
  }

  /// 换到相邻的会话：新页面从滑动的方向进来。
  void _go(String paneId, bool forward) {
    HapticFeedback.selectionClick();
    Navigator.of(context).pushReplacement(
      PageRouteBuilder(
        transitionDuration: const Duration(milliseconds: 260),
        reverseTransitionDuration: const Duration(milliseconds: 220),
        pageBuilder: (_, _, _) => SessionPage(paneId: paneId),
        transitionsBuilder: (_, anim, _, child) => SlideTransition(
          position: Tween(begin: Offset(forward ? 1 : -1, 0), end: Offset.zero).animate(CurvedAnimation(parent: anim, curve: Curves.easeOutCubic)),
          child: child,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final p = Palette.of(context);
    final found = app.overview?.find(widget.paneId);
    if (app.overview == null) return const Scaffold(body: Center(child: CircularProgressIndicator(strokeWidth: 2)));
    if (found == null) {
      return Scaffold(
        appBar: AppBar(),
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('这个会话已经关闭', style: TextStyle(fontSize: 16)),
              const SizedBox(height: 6),
              Text('它可能被归档，或在电脑上被关掉了。', style: TextStyle(color: p.mutedFg)),
            ],
          ),
        ),
      );
    }
    final (s, project) = found;
    final view = s.kind == SessionKind.shell ? SessionView.terminal : (_view ?? SessionView.terminal);
    final order = navigationOrder(app.overview!, app.projectSort, app.unassignedSort);
    final i = order.indexWhere((x) => x.paneId == s.paneId);
    final prev = i > 0 ? order[i - 1].paneId : null;
    final next = i >= 0 && i < order.length - 1 ? order[i + 1].paneId : null;
    final status = statusLabel[s.status];

    return Scaffold(
      resizeToAvoidBottomInset: true,
      body: SafeArea(
        child: Column(
          children: [
            // 标题栏：左右滑切换会话
            GestureDetector(
              onHorizontalDragUpdate: (d) => setState(() => _dragX += d.delta.dx),
              onHorizontalDragEnd: (d) {
                final dx = _dragX;
                setState(() => _dragX = 0);
                if ((dx > 60 || d.primaryVelocity! > 600) && prev != null) _go(prev, false);
                if ((dx < -60 || d.primaryVelocity! < -600) && next != null) _go(next, true);
              },
              child: Container(
                padding: const EdgeInsets.fromLTRB(4, 4, 4, 6),
                decoration: BoxDecoration(
                  border: Border(bottom: BorderSide(color: p.border)),
                ),
                child: Row(
                  children: [
                    IconButton(icon: const Icon(Icons.arrow_back_rounded), onPressed: () => Navigator.pop(context)),
                    Hero(
                      tag: 'icon-${s.paneId}',
                      child: AgentIcon(kind: s.kind, status: s.status, size: 32),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: AnimatedSlide(
                        offset: Offset(_dragX / 400, 0),
                        duration: _dragX == 0 ? const Duration(milliseconds: 200) : Duration.zero,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              s.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
                            ),
                            Text(
                              '${project?.note ?? project?.name ?? '未归属'}${status != null ? ' · $status' : ''}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 12, color: p.mutedFg),
                            ),
                          ],
                        ),
                      ),
                    ),
                    if (s.kind != SessionKind.shell)
                      SegmentedSwitch(value: view, options: const {SessionView.terminal: '终端', SessionView.chat: '对话'}, onChanged: _setView),
                    IconButton(icon: const Icon(Icons.more_vert_rounded), onPressed: () => sessionMenu(context, s, project)),
                  ],
                ),
              ),
            ),
            Expanded(
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 220),
                child: s.restoreError != null
                    ? _RestoreError(session: s)
                    : view == SessionView.terminal
                    ? Column(
                        key: const ValueKey('terminal'),
                        children: [
                          Expanded(
                            child: TerminalPane(key: _term, paneId: s.paneId),
                          ),
                          KeyBar(term: _term, paneId: s.paneId),
                        ],
                      )
                    : _ChatView(key: const ValueKey('chat'), session: s, projectId: project?.id, onTerminal: () => _setView(SessionView.terminal)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RestoreError extends StatelessWidget {
  final Session session;
  const _RestoreError({required this.session});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('这个会话没能恢复', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w500)),
            const SizedBox(height: 8),
            Text(
              '启动目录 ${session.cwd} 已经不存在，herdr 重启时只保留了位置。把目录放回去后在电脑上重启这个会话，或者直接关闭它。',
              textAlign: TextAlign.center,
              style: TextStyle(color: p.mutedFg),
            ),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: () => closeSession(context, session), child: const Text('关闭这个会话')),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

class _ChatView extends StatefulWidget {
  final Session session;

  /// 所在的项目：对话里的图片只能显示项目内的。
  final String? projectId;
  final VoidCallback onTerminal;
  const _ChatView({super.key, required this.session, required this.projectId, required this.onTerminal});

  @override
  State<_ChatView> createState() => _ChatViewState();
}

/// 输入框里待发送的附件：选好就开始上传，发送时附上电脑上的路径。
class _Attachment {
  final LocalFile file;
  Uploaded? uploaded;
  String? error;
  _Attachment(this.file);
}

class _ChatViewState extends State<_ChatView> {
  final _input = TextEditingController();
  late final AppState _app;
  bool _sending = false;
  final List<_Attachment> _attachments = [];

  void _add(List<LocalFile> files) {
    for (final f in files) {
      final a = _Attachment(f);
      setState(() => _attachments.add(a));
      _app.api
          .uploadForSession(widget.session.paneId, f)
          .then((u) => mounted ? setState(() => a.uploaded = u) : null, onError: (e) => mounted ? setState(() => a.error = e.toString()) : null);
    }
  }

  Future<void> _pasteFile() async {
    final f = await Native.clipboardFile();
    if (f == null) {
      if (mounted) toast(context, '剪贴板里没有图片或文件');
      return;
    }
    _add([f]);
  }

  @override
  void initState() {
    super.initState();
    _app = AppScope.read(context);
    _app.watch(widget.session.paneId);
  }

  @override
  void dispose() {
    _app.unwatch(widget.session.paneId);
    _input.dispose();
    super.dispose();
  }

  bool get _uploading => _attachments.any((a) => a.uploaded == null && a.error == null);

  Future<void> _send() async {
    final text = _input.text.trim();
    final files = [for (final a in _attachments) ?a.uploaded?.path];
    if ((text.isEmpty && files.isEmpty) || _sending || _uploading) return;
    setState(() => _sending = true);
    final ok = await run(context, () => _app.api.prompt(widget.session.paneId, text, files).then((_) => true));
    if (!mounted) return;
    setState(() => _sending = false);
    if (ok == true) {
      _input.clear();
      setState(() => _attachments.clear());
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final p = Palette.of(context);
    final t = app.transcripts[widget.session.paneId];
    final entries = t?.entries ?? const [];
    return Column(
      children: [
        Expanded(
          child: t == null || !t.loaded
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : entries.isEmpty
              ? Center(
                  child: Text(t.conversationId == null ? '还没有对话记录' : '还没有消息', style: TextStyle(color: p.mutedFg)),
                )
              // 从底部开始排列，新消息出现在最下面
              : ListView.builder(
                  reverse: true,
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
                  itemCount: entries.length,
                  itemBuilder: (context, i) => _Bubble(entry: entries[entries.length - 1 - i], projectId: widget.projectId),
                ),
        ),
        if (widget.session.status == SessionStatus.blocked)
          Material(
            color: p.blocked.withValues(alpha: 0.12),
            child: InkWell(
              onTap: widget.onTerminal,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: Row(
                  children: [
                    Icon(Icons.pan_tool_alt_outlined, size: 18, color: p.blocked),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text('在等你确认权限或选择选项', style: TextStyle(color: p.blocked)),
                    ),
                    Text(
                      '去终端处理',
                      style: TextStyle(color: p.blocked, fontWeight: FontWeight.w600),
                    ),
                  ],
                ),
              ),
            ),
          ),
        Container(
          decoration: BoxDecoration(
            color: p.card,
            border: Border(top: BorderSide(color: p.border)),
          ),
          padding: const EdgeInsets.fromLTRB(4, 8, 8, 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_attachments.isNotEmpty)
                SizedBox(
                  height: 72,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.fromLTRB(8, 0, 0, 8),
                    children: [for (final a in _attachments) _AttachmentChip(a: a, onRemove: () => setState(() => _attachments.remove(a)))],
                  ),
                ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  IconButton(
                    tooltip: '添加图片或文件',
                    icon: const Icon(Icons.add_circle_outline_rounded),
                    onPressed: () async => _add(await pickAttachments(context)),
                  ),
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 6,
                      textInputAction: TextInputAction.newline,
                      // 输入法里插入的图片（剪贴板图片、表情图）直接作为附件
                      contentInsertionConfiguration: ContentInsertionConfiguration(
                        onContentInserted: (c) {
                          final data = c.data;
                          if (data != null) _add([LocalFile.bytes('image.${c.mimeType.split('/').last}', data, mime: c.mimeType)]);
                        },
                      ),
                      // 长按菜单里加上「粘贴图片 / 文件」（系统的粘贴只认文字）
                      contextMenuBuilder: (context, state) => AdaptiveTextSelectionToolbar.buttonItems(
                        anchors: state.contextMenuAnchors,
                        buttonItems: [
                          ...state.contextMenuButtonItems,
                          ContextMenuButtonItem(
                            label: '粘贴图片',
                            onPressed: () {
                              state.hideToolbar();
                              _pasteFile();
                            },
                          ),
                        ],
                      ),
                      decoration: InputDecoration(
                        hintText: '发消息给 ${kindLabel[widget.session.kind]}…',
                        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  IconButton.filled(
                    onPressed: _sending || _uploading ? null : _send,
                    icon: _sending
                        ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.arrow_upward_rounded),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _AttachmentChip extends StatelessWidget {
  final _Attachment a;
  final VoidCallback onRemove;
  const _AttachmentChip({required this.a, required this.onRemove});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final preview = a.file.preview;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Container(
              width: preview != null ? 64 : 140,
              height: 64,
              color: p.muted,
              child: preview != null
                  ? Image.memory(preview, fit: BoxFit.cover)
                  : Padding(
                      padding: const EdgeInsets.all(8),
                      child: Row(
                        children: [
                          Icon(Icons.insert_drive_file_outlined, size: 20, color: p.mutedFg),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(a.file.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11)),
                          ),
                        ],
                      ),
                    ),
            ),
          ),
          if (a.uploaded == null && a.error == null)
            Positioned.fill(
              child: Container(
                decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(10)),
                child: const Center(
                  child: SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)),
                ),
              ),
            ),
          if (a.error != null)
            Positioned.fill(
              child: Tooltip(
                message: a.error!,
                child: Container(
                  decoration: BoxDecoration(color: p.destructive.withValues(alpha: 0.5), borderRadius: BorderRadius.circular(10)),
                  child: const Icon(Icons.error_outline_rounded, color: Colors.white),
                ),
              ),
            ),
          Positioned(
            right: -6,
            top: -6,
            child: GestureDetector(
              onTap: onRemove,
              child: Container(
                decoration: BoxDecoration(
                  color: p.fg,
                  shape: BoxShape.circle,
                  border: Border.all(color: p.card, width: 2),
                ),
                padding: const EdgeInsets.all(2),
                child: Icon(Icons.close_rounded, size: 12, color: p.bg),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  final TranscriptEntry entry;
  final String? projectId;
  const _Bubble({required this.entry, required this.projectId});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final e = entry;
    switch (e) {
      case UserEntry():
        final app = AppScope.read(context);
        return Align(
          alignment: Alignment.centerRight,
          child: Container(
            margin: const EdgeInsets.only(left: 48, top: 6, bottom: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                // 发过的图片：缩略图，点开看大图
                if (e.images.isNotEmpty && projectId != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      alignment: WrapAlignment.end,
                      children: [
                        for (final path in e.images)
                          Builder(
                            builder: (context) {
                              final img = NetworkImage(app.api.imageUrl(projectId!, path).toString(), headers: app.conn.headers);
                              return GestureDetector(
                                onTap: () => ImageViewer.open(context, img, title: path.split('/').last),
                                child: ClipRRect(
                                  borderRadius: BorderRadius.circular(12),
                                  child: Image(
                                    image: img,
                                    width: 120,
                                    height: 120,
                                    fit: BoxFit.cover,
                                    errorBuilder: (_, _, _) => Container(
                                      width: 120,
                                      height: 120,
                                      color: p.muted,
                                      child: Icon(Icons.broken_image_outlined, color: p.mutedFg),
                                    ),
                                  ),
                                ),
                              );
                            },
                          ),
                      ],
                    ),
                  ),
                if (e.text.isNotEmpty)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    decoration: BoxDecoration(color: p.secondary, borderRadius: BorderRadius.circular(16)),
                    child: SelectableText(e.text, style: const TextStyle(fontSize: 15, height: 1.45)),
                  ),
              ],
            ),
          ),
        );
      case AssistantEntry():
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: MarkdownBody(
            data: e.text,
            selectable: true,
            styleSheet: MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
              p: const TextStyle(fontSize: 15, height: 1.55),
              code: TextStyle(fontFamily: mono, fontSize: 13, backgroundColor: p.muted),
              codeblockDecoration: BoxDecoration(
                color: p.card,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: p.border),
              ),
              codeblockPadding: const EdgeInsets.all(12),
              blockquoteDecoration: BoxDecoration(
                border: Border(left: BorderSide(color: p.border, width: 3)),
              ),
              tableBorder: TableBorder.all(color: p.border),
            ),
          ),
        );
      case ToolEntry():
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(Icons.build_outlined, size: 14, color: p.mutedFg),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: e.name,
                        style: TextStyle(color: p.fg.withValues(alpha: 0.8), fontWeight: FontWeight.w500),
                      ),
                      if (e.summary.isNotEmpty) TextSpan(text: '  ${e.summary}'),
                    ],
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, color: p.mutedFg, fontFamily: mono),
                ),
              ),
            ],
          ),
        );
    }
  }
}
