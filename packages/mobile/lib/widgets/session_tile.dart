import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_slidable/flutter_slidable.dart';
import '../api/models.dart';
import '../pages/session_page.dart';
import '../state.dart';
import '../theme.dart';
import 'agent_icon.dart';
import 'common.dart';

const kindLabel = {SessionKind.claude: 'Claude', SessionKind.codex: 'Codex', SessionKind.shell: '终端'};
const statusLabel = {
  SessionStatus.working: '工作中',
  SessionStatus.blocked: '需处理',
  SessionStatus.done: '已完成',
};

void openSession(BuildContext context, String paneId) {
  Navigator.of(context).push(MaterialPageRoute(builder: (_) => SessionPage(paneId: paneId)));
}

/// 列表里的一个会话：点开进入；左滑露出「隐藏 / 归档（临时终端是关闭）」；长按弹出全部操作。
class SessionTile extends StatelessWidget {
  final Session session;
  final Project? project;
  /// 拖动排序的把手（herdr 顺序下）。
  final Widget? handle;
  const SessionTile({super.key, required this.session, this.project, this.handle});

  @override
  Widget build(BuildContext context) {
    final s = session;
    final p = Palette.of(context);
    final status = statusLabel[s.status];
    final statusColor = switch (s.status) {
      SessionStatus.working => p.working,
      SessionStatus.blocked => p.blocked,
      SessionStatus.done => p.done,
      _ => p.mutedFg,
    };
    return Slidable(
      key: ValueKey(s.paneId),
      groupTag: 'sessions',
      endActionPane: ActionPane(
        motion: const BehindMotion(),
        extentRatio: 0.42,
        children: [
          SlidableAction(
            onPressed: (_) => run(context, () => AppScope.read(context).api.setHidden(s.paneId, !s.hidden)),
            backgroundColor: p.secondary,
            foregroundColor: p.fg,
            icon: s.hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined,
            label: s.hidden ? '取消隐藏' : '隐藏',
          ),
          SlidableAction(
            onPressed: (_) => s.kind == SessionKind.shell ? closeSession(context, s) : archiveSession(context, s),
            backgroundColor: p.destructive.withValues(alpha: 0.9),
            foregroundColor: Colors.white,
            icon: s.kind == SessionKind.shell ? Icons.close_rounded : Icons.archive_outlined,
            label: s.kind == SessionKind.shell ? '关闭' : '归档',
          ),
        ],
      ),
      child: Opacity(
        opacity: s.hidden ? 0.5 : 1,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => openSession(context, s.paneId),
          onLongPress: () {
            HapticFeedback.mediumImpact();
            sessionMenu(context, s, project);
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(children: [
              Hero(tag: 'icon-${s.paneId}', child: AgentIcon(kind: s.kind, status: s.status)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 15)),
                  const SizedBox(height: 1),
                  Text.rich(
                    TextSpan(children: [
                      if (s.restoreError != null)
                        TextSpan(text: '目录已不存在', style: TextStyle(color: p.destructive))
                      else if (status != null)
                        TextSpan(text: status, style: TextStyle(color: statusColor))
                      else
                        TextSpan(text: kindLabel[s.kind]),
                      if (project == null) TextSpan(text: ' · ${shortPath(s.cwd)}', style: const TextStyle(fontFamily: mono)),
                    ]),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, color: p.mutedFg),
                  ),
                ]),
              ),
              ?handle,
            ]),
          ),
        ),
      ),
    );
  }
}

Future<void> archiveSession(BuildContext context, Session s) async {
  if (s.status == SessionStatus.working &&
      !await confirm(context, title: '归档正在工作的会话？', body: '归档会立即关闭这个 pane，正在进行的任务会被中断。对话可以之后恢复。', action: '归档', destructive: true)) {
    return;
  }
  if (context.mounted) await run(context, () => AppScope.read(context).api.archive(s.paneId), success: '已归档');
}

Future<void> closeSession(BuildContext context, Session s) async {
  if (!await confirm(context, title: '关闭这个终端？', body: '终端里正在运行的程序会被结束。', action: '关闭', destructive: true)) return;
  if (context.mounted) await run(context, () => AppScope.read(context).api.close(s.paneId));
}

Future<void> renameSession(BuildContext context, Session s) async {
  final v = await promptText(context, title: '重命名会话', initial: s.title, hint: '留空恢复自动标题');
  if (v == null || v == s.title || !context.mounted) return;
  await run(context, () => AppScope.read(context).api.rename(s.paneId, v.isEmpty ? null : v));
}

void sessionMenu(BuildContext context, Session s, Project? project) {
  final app = AppScope.read(context);
  showActions(context, title: s.title, subtitle: shortPath(s.cwd), actions: [
    SheetAction(Icons.open_in_new_rounded, '打开', () => openSession(context, s.paneId)),
    SheetAction(Icons.edit_outlined, '重命名', () => renameSession(context, s)),
    if (s.renamed) SheetAction(Icons.restart_alt_rounded, '恢复自动标题', () => run(context, () => app.api.rename(s.paneId, null))),
    SheetAction(Icons.copy_rounded, '复制目录路径', () {
      Clipboard.setData(ClipboardData(text: s.cwd));
      toast(context, '已复制');
    }),
    SheetAction(Icons.drive_file_move_outline, project == null ? '移到项目…' : '移到其他项目…', () => moveToProject(context, s, project)),
    SheetAction(s.hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined, s.hidden ? '取消隐藏' : '隐藏',
        () => run(context, () => app.api.setHidden(s.paneId, !s.hidden))),
    if (s.kind != SessionKind.shell) SheetAction(Icons.archive_outlined, '归档（关闭 pane，保留对话）', () => archiveSession(context, s)),
    if (s.kind == SessionKind.shell) SheetAction(Icons.close_rounded, '关闭终端', () => closeSession(context, s), destructive: true),
  ]);
}

Future<void> moveToProject(BuildContext context, Session s, Project? current) async {
  final app = AppScope.read(context);
  final projects = (app.overview?.projects ?? []).where((p) => !p.archived && p.id != current?.id).toList();
  if (projects.isEmpty) {
    toast(context, '没有其他项目');
    return;
  }
  await showActions(context, title: '移到项目', subtitle: s.title, actions: [
    for (final p in projects)
      SheetAction(Icons.folder_outlined, p.note ?? p.name, () => run(context, () => app.api.moveToProject(s.paneId, p.id), success: '已移到 ${p.note ?? p.name}')),
  ]);
}
