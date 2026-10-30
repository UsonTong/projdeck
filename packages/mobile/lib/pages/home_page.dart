import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_slidable/flutter_slidable.dart';
import '../api/models.dart';
import '../sort.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/agent_icon.dart';
import '../widgets/common.dart';
import '../widgets/session_tile.dart';
import 'settings_page.dart';

/// 总览：项目 / 未归属 / 归档三栏，左右滑动切换。
class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 3, vsync: this);

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final p = Palette.of(context);
    final o = app.overview;
    bool visible(Session s) => app.showHidden || !s.hidden;
    final hiddenCount = o == null ? 0 : [...o.projects.expand((p) => p.sessions), ...o.unassigned].where((s) => s.hidden).length;
    final unassigned = o?.unassigned.where(visible).toList() ?? [];
    final archivedCount = (o?.archived.length ?? 0) + (o?.projects.where((p) => p.archived).length ?? 0);

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: SlidableAutoCloseBehavior(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 6, 4),
              child: Row(children: [
                Expanded(
                  child: Container(
                    height: 38,
                    decoration: BoxDecoration(color: p.muted, borderRadius: BorderRadius.circular(10)),
                    padding: const EdgeInsets.all(3),
                    child: TabBar(
                      controller: _tabs,
                      dividerHeight: 0,
                      indicatorSize: TabBarIndicatorSize.tab,
                      indicator: BoxDecoration(color: p.bg, borderRadius: BorderRadius.circular(8), border: Border.all(color: p.border)),
                      labelColor: p.fg,
                      unselectedLabelColor: p.mutedFg,
                      labelStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                      splashBorderRadius: BorderRadius.circular(8),
                      tabs: [
                        const Tab(text: '项目'),
                        _TabLabel('未归属', unassigned.length),
                        _TabLabel('归档', archivedCount),
                      ],
                    ),
                  ),
                ),
                if (hiddenCount > 0)
                  IconButton(
                    tooltip: app.showHidden ? '不显示隐藏的会话' : '显示隐藏的会话（$hiddenCount）',
                    icon: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 200),
                      child: Icon(app.showHidden ? Icons.visibility_outlined : Icons.visibility_off_outlined, key: ValueKey(app.showHidden), size: 20),
                    ),
                    onPressed: () => app.showHidden = !app.showHidden,
                  ),
                IconButton(
                  tooltip: '设置',
                  icon: const Icon(Icons.settings_outlined, size: 20),
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SettingsPage())),
                ),
              ]),
            ),
            if (!app.connected || (o != null && !o.herdrOnline)) _Banner(overview: o, connected: app.connected),
            Expanded(
              child: o == null
                  ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                  : TabBarView(controller: _tabs, children: [
                      _ProjectsTab(overview: o, visible: visible),
                      _UnassignedTab(sessions: unassigned),
                      _ArchivedTab(overview: o),
                    ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _TabLabel extends StatelessWidget {
  final String text;
  final int count;
  const _TabLabel(this.text, this.count);

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Tab(
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Text(text),
        if (count > 0) ...[
          const SizedBox(width: 5),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(color: p.muted, borderRadius: BorderRadius.circular(8)),
            child: Text('$count', style: TextStyle(fontSize: 10, color: p.mutedFg)),
          ),
        ],
      ]),
    );
  }
}

/// 连不上电脑、或 herdr 没在运行。
class _Banner extends StatelessWidget {
  final Overview? overview;
  final bool connected;
  const _Banner({required this.overview, required this.connected});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final app = AppScope.read(context);
    final herdrDown = connected && overview != null && !overview!.herdrOnline;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(color: p.destructive.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(10)),
      child: Row(children: [
        Icon(herdrDown ? Icons.terminal_rounded : Icons.cloud_off_rounded, size: 18, color: p.destructive),
        const SizedBox(width: 8),
        Expanded(child: Text(herdrDown ? 'herdr 没有在运行' : '正在连接电脑…', style: TextStyle(fontSize: 13, color: p.destructive))),
        if (herdrDown) TextButton(onPressed: () => run(context, app.api.startHerdr), child: const Text('启动 herdr')),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

class _ProjectsTab extends StatelessWidget {
  final Overview overview;
  final bool Function(Session) visible;
  const _ProjectsTab({required this.overview, required this.visible});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final sort = app.projectSort;
    final projects = sortProjects(overview.projects, sort);
    final header = Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      child: Align(
        alignment: Alignment.centerRight,
        child: SegmentedSwitch(value: sort, options: projectSortLabels, onChanged: (v) => app.projectSort = v),
      ),
    );
    if (projects.isEmpty) {
      return ListView(children: [header, const _Empty(icon: Icons.folder_open_rounded, text: '还没有项目')]);
    }
    if (sort != ProjectSort.custom) {
      return ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          header,
          for (final pr in projects) _ProjectGroup(key: ValueKey(pr.id), project: pr, sessions: pr.sessions.where(visible).toList(), sort: sort),
        ],
      );
    }
    // 自定义：按住标题右侧的把手拖动
    return ReorderableListView.builder(
      padding: const EdgeInsets.only(bottom: 32),
      header: header,
      buildDefaultDragHandles: false,
      itemCount: projects.length,
      proxyDecorator: (child, _, _) => Material(color: Palette.of(context).card, elevation: 6, borderRadius: BorderRadius.circular(12), child: child),
      onReorderItem: (from, to) {
        final ids = projects.map((p) => p.id).toList();
        ids.insert(to, ids.removeAt(from));
        run(context, () => app.api.reorderProjects(ids));
      },
      itemBuilder: (context, i) {
        final pr = projects[i];
        return _ProjectGroup(key: ValueKey(pr.id), project: pr, sessions: pr.sessions.where(visible).toList(), sort: sort, dragIndex: i);
      },
    );
  }
}

class _ProjectGroup extends StatelessWidget {
  final Project project;
  final List<Session> sessions;
  final ProjectSort sort;
  final int? dragIndex;
  const _ProjectGroup({super.key, required this.project, required this.sessions, required this.sort, this.dragIndex});

  Future<void> _start(BuildContext context, SessionKind kind) async {
    HapticFeedback.lightImpact();
    final paneId = await run(context, () => AppScope.read(context).api.startSession(project.id, kind));
    if (paneId != null && context.mounted) openSession(context, paneId);
  }

  Future<void> _editNote(BuildContext context) async {
    final v = await promptText(context, title: '项目备注', initial: project.note ?? '', hint: '给「${project.name}」写个备注，留空清除');
    if (v == null || v == (project.note ?? '') || !context.mounted) return;
    await run(context, () => AppScope.read(context).api.updateProject(project.id, {'note': v}));
  }

  void _menu(BuildContext context) {
    final app = AppScope.read(context);
    final starters = project.defaultAgent == SessionKind.codex ? [SessionKind.codex, SessionKind.claude] : [SessionKind.claude, SessionKind.codex];
    showActions(context, title: project.note ?? project.name, subtitle: shortPath(project.path), actions: [
      SheetAction(Icons.edit_note_rounded, project.note == null ? '添加备注' : '修改备注', () => _editNote(context)),
      for (final k in starters) SheetAction(Icons.add_rounded, '新开 ${kindLabel[k]}', () => _start(context, k)),
      SheetAction(Icons.terminal_rounded, '新开临时终端', () => _start(context, SessionKind.shell)),
      SheetAction(Icons.copy_rounded, '复制路径', () {
        Clipboard.setData(ClipboardData(text: project.path));
        toast(context, '已复制');
      }),
      SheetAction(project.notify ? Icons.notifications_off_outlined : Icons.notifications_outlined, project.notify ? '不推送这个项目的通知' : '推送这个项目的通知',
          () => run(context, () => app.api.updateProject(project.id, {'notify': !project.notify}))),
      SheetAction(Icons.archive_outlined, '归档项目', () => run(context, () => app.api.updateProject(project.id, {'archived': true}), success: '已归档')),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final sorted = sortProjectSessions(sessions, sort);
    final starters = project.defaultAgent == SessionKind.codex ? [SessionKind.codex, SessionKind.claude] : [SessionKind.claude, SessionKind.codex];
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 6, 4, 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        InkWell(
          borderRadius: BorderRadius.circular(10),
          onLongPress: () {
            HapticFeedback.mediumImpact();
            _menu(context);
          },
          onDoubleTap: () => _editNote(context),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 4, 6),
            child: Row(children: [
              // 备注醒目地显示在最上面，文件夹名和路径退到下面一行
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  AnimatedSize(
                    duration: const Duration(milliseconds: 200),
                    alignment: Alignment.topLeft,
                    child: Text(project.note ?? project.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: project.note != null ? 18 : 15, fontWeight: FontWeight.w600, height: 1.3)),
                  ),
                  Text.rich(
                    TextSpan(children: [
                      if (project.note != null) TextSpan(text: '${project.name} · ', style: TextStyle(color: p.fg.withValues(alpha: 0.7), fontWeight: FontWeight.w500)),
                      TextSpan(text: shortPath(project.path), style: const TextStyle(fontFamily: mono)),
                    ]),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, color: p.mutedFg),
                  ),
                ]),
              ),
              for (final k in starters)
                _IconTap(tooltip: '新开 ${kindLabel[k]}', onTap: () => _start(context, k), child: AgentIcon(kind: k, size: 24, plus: true)),
              _IconTap(tooltip: '新开临时终端', onTap: () => _start(context, SessionKind.shell), child: const AgentIcon(kind: SessionKind.shell, size: 24, plus: true)),
              _IconTap(tooltip: '更多', onTap: () => _menu(context), child: Icon(Icons.more_horiz_rounded, size: 20, color: p.mutedFg)),
              if (dragIndex != null)
                ReorderableDragStartListener(
                  index: dragIndex!,
                  child: Padding(padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8), child: Icon(Icons.drag_indicator_rounded, size: 20, color: p.mutedFg)),
                ),
            ]),
          ),
        ),
        AnimatedSize(
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
          alignment: Alignment.topCenter,
          child: sorted.isEmpty
              ? Padding(
                  padding: const EdgeInsets.fromLTRB(14, 2, 14, 4),
                  child: Text('没有运行中的会话，点上方图标新开一个', style: TextStyle(fontSize: 12, color: p.mutedFg)),
                )
              : Column(children: [for (final s in sorted) SessionTile(key: ValueKey(s.paneId), session: s, project: project)]),
        ),
      ]),
    );
  }
}

class _IconTap extends StatelessWidget {
  final String tooltip;
  final VoidCallback onTap;
  final Widget child;
  const _IconTap({required this.tooltip, required this.onTap, required this.child});

  @override
  Widget build(BuildContext context) => Tooltip(
        message: tooltip,
        child: InkResponse(onTap: onTap, radius: 22, child: Padding(padding: const EdgeInsets.all(8), child: child)),
      );
}

// ---------------------------------------------------------------------------
// 未归属
// ---------------------------------------------------------------------------

class _UnassignedTab extends StatelessWidget {
  final List<Session> sessions;
  const _UnassignedTab({required this.sessions});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final p = Palette.of(context);
    final sort = app.unassignedSort;
    final sorted = sortUnassigned(sessions, sort);
    final header = Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      child: Align(
        alignment: Alignment.centerRight,
        child: SegmentedSwitch(value: sort, options: unassignedSortLabels, onChanged: (v) => app.unassignedSort = v),
      ),
    );
    if (sorted.isEmpty) return ListView(children: [header, const _Empty(icon: Icons.inbox_rounded, text: '没有未归属的会话')]);
    if (sort != UnassignedSort.herdr) {
      return ListView(padding: const EdgeInsets.fromLTRB(4, 0, 4, 32), children: [header, for (final s in sorted) SessionTile(key: ValueKey(s.paneId), session: s)]);
    }
    // herdr 顺序：按住右侧把手拖动，电脑上 herdr 的侧栏同步调整
    return ReorderableListView.builder(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 32),
      header: header,
      buildDefaultDragHandles: false,
      itemCount: sorted.length,
      proxyDecorator: (child, _, _) => Material(color: p.card, elevation: 6, borderRadius: BorderRadius.circular(12), child: child),
      onReorderItem: (from, to) {
        final list = [...sorted];
        final moved = list.removeAt(from);
        list.insert(to, moved);
        final i = list.indexOf(moved);
        run(context, () => app.api.moveBefore(moved.paneId, i + 1 < list.length ? list[i + 1].paneId : null));
      },
      itemBuilder: (context, i) => SessionTile(
        key: ValueKey(sorted[i].paneId),
        session: sorted[i],
        handle: ReorderableDragStartListener(
          index: i,
          child: Padding(padding: const EdgeInsets.only(left: 8), child: Icon(Icons.drag_indicator_rounded, size: 20, color: p.mutedFg)),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 归档
// ---------------------------------------------------------------------------

class _ArchivedTab extends StatelessWidget {
  final Overview overview;
  const _ArchivedTab({required this.overview});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final p = Palette.of(context);
    final archivedProjects = overview.projects.where((p) => p.archived).toList();
    final names = {for (final p in overview.projects) p.id: p.note ?? p.name};
    if (overview.archived.isEmpty && archivedProjects.isEmpty) return const _Empty(icon: Icons.archive_outlined, text: '没有归档的会话');
    return ListView(padding: const EdgeInsets.fromLTRB(4, 4, 4, 32), children: [
      for (final a in overview.archived)
        ListTile(
          leading: AgentIcon(kind: a.kind),
          title: Text(a.title, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Text(a.projectId != null ? (names[a.projectId] ?? '已删除的项目') : shortPath(a.cwd),
              maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: p.mutedFg)),
          onTap: () async {
            final paneId = await run(context, () => app.api.restore(a.id));
            if (paneId != null && context.mounted) openSession(context, paneId);
          },
          onLongPress: () => showActions(context, title: a.title, subtitle: shortPath(a.cwd), actions: [
            SheetAction(Icons.unarchive_outlined, '恢复（继续这个对话）', () async {
              final paneId = await run(context, () => app.api.restore(a.id));
              if (paneId != null && context.mounted) openSession(context, paneId);
            }),
            SheetAction(Icons.delete_outline_rounded, '删除归档记录', () async {
              if (await confirm(context, title: '删除这条归档记录？', body: '只删除 projdeck 里的记录，对话文件本身不会删除。', action: '删除', destructive: true) && context.mounted) {
                run(context, () => app.api.deleteArchive(a.id));
              }
            }, destructive: true),
          ]),
        ),
      if (archivedProjects.isNotEmpty) ...[
        Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 4), child: Text('归档的项目', style: TextStyle(fontSize: 12, color: p.mutedFg))),
        for (final pr in archivedProjects)
          ListTile(
            leading: Icon(Icons.folder_outlined, color: p.folder),
            title: Text(pr.note ?? pr.name),
            subtitle: Text(shortPath(pr.path), style: TextStyle(fontSize: 12, color: p.mutedFg, fontFamily: mono)),
            trailing: TextButton(onPressed: () => run(context, () => app.api.updateProject(pr.id, {'archived': false})), child: const Text('恢复')),
          ),
      ],
    ]);
  }
}

class _Empty extends StatelessWidget {
  final IconData icon;
  final String text;
  const _Empty({required this.icon, required this.text});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 80),
      child: Column(children: [
        Icon(icon, size: 36, color: p.mutedFg),
        const SizedBox(height: 10),
        Text(text, style: TextStyle(color: p.mutedFg)),
      ]),
    );
  }
}
