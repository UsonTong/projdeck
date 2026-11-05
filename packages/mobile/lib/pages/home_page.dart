import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_slidable/flutter_slidable.dart';

import '../api/models.dart';
import '../native.dart';
import '../sort.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/app_update.dart';
import '../widgets/agent_icon.dart';
import '../widgets/common.dart';
import '../widgets/session_tile.dart';
import '../api/ccswitch.dart';
import 'ccswitch_page.dart';
import 'devices_page.dart';
import 'files_page.dart';
import 'settings_page.dart';

/// 总览：项目 / 未归属 / 归档三栏，左右滑动切换。
class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final TabController _tabs = TabController(length: 3, vsync: this);
  // 电脑上装了 CC Switch 才显示它的入口
  bool _ccswitch = false;
  // 服务器上发布了更新的版本时，这里放着新版本号；关掉后本次不再提示
  String? _newVersion;
  bool _updateDismissed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    AppScope.read(context).api.ccStatus().then((s) => mounted && s.installed ? setState(() => _ccswitch = true) : null, onError: (_) {});
    _checkUpdate();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _checkUpdate();
  }

  /// 电脑上的 projdeck 发布了新的安卓版本就提示一下（版本号是「2.4.4+441178」这种，后面是 build 号）。
  Future<void> _checkUpdate() async {
    try {
      final server = await AppScope.read(context).api.androidApp();
      if (server == null) return;
      final mine = await Native.appVersion();
      final latest = int.tryParse(server['version'].toString().split('+').last) ?? 0;
      final current = (mine['code'] as num?)?.toInt() ?? 0;
      if (latest > current && mounted && !_updateDismissed) setState(() => _newVersion = server['version'].toString().split('+').first);
    } catch (_) {
      // 连不上就下次再说
    }
  }

  Future<void> _downloadUpdate() async {
    final app = AppScope.read(context);
    if (!mounted) return;
    await installAppUpdate(context, app.conn);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
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
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 6, 4),
                child: Row(
                  children: [
                    Expanded(
                      child: Container(
                        height: 38,
                        decoration: BoxDecoration(color: p.muted, borderRadius: BorderRadius.circular(10)),
                        padding: const EdgeInsets.all(3),
                        child: TabBar(
                          controller: _tabs,
                          dividerHeight: 0,
                          indicatorSize: TabBarIndicatorSize.tab,
                          indicator: BoxDecoration(
                            color: p.bg,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: p.border),
                          ),
                          labelColor: p.fg,
                          unselectedLabelColor: p.mutedFg,
                          labelPadding: const EdgeInsets.symmetric(horizontal: 4),
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
                          child: Icon(
                            app.showHidden ? Icons.visibility_outlined : Icons.visibility_off_outlined,
                            key: ValueKey(app.showHidden),
                            size: 20,
                          ),
                        ),
                        onPressed: () => app.showHidden = !app.showHidden,
                      ),
                    if (o?.harness?.configured == true)
                      IconButton(
                        tooltip: 'DeepSeek Harness 原版网页',
                        icon: const AgentIcon(kind: SessionKind.harness, size: 22),
                        onPressed: () => openHarnessWeb(context),
                      ),
                    if (_ccswitch)
                      IconButton(
                        tooltip: 'CC Switch：用量、切换供应商',
                        icon: const Icon(Icons.swap_horiz_rounded, size: 22),
                        onPressed: () => CcSwitchPage.open(context),
                      ),
                    IconButton(
                      tooltip: '设备：连进来的手机',
                      icon: const Icon(Icons.smartphone_rounded, size: 21),
                      onPressed: () => DevicesPage.open(context),
                    ),
                    IconButton(
                      tooltip: '设置',
                      icon: const Icon(Icons.settings_outlined, size: 20),
                      onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SettingsPage())),
                    ),
                  ],
                ),
              ),
              if (_newVersion != null)
                _UpdateBanner(
                  version: _newVersion!,
                  onUpdate: _downloadUpdate,
                  onDismiss: () => setState(() {
                    _updateDismissed = true;
                    _newVersion = null;
                  }),
                ),
              if (!app.connected || (o != null && !o.herdrOnline)) _Banner(overview: o, connected: app.connected),
              Expanded(
                child: o == null
                    ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                    : TabBarView(
                        controller: _tabs,
                        children: [
                          _ProjectsTab(overview: o, visible: visible),
                          _UnassignedTab(sessions: unassigned),
                          _ArchivedTab(overview: o),
                        ],
                      ),
              ),
            ],
          ),
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
    // 标签变窄时文字先省略，计数徽标完整保留，不会被挤出标签
    return Tab(
      height: 30,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Flexible(child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, softWrap: false)),
          if (count > 0) ...[
            const SizedBox(width: 4),
            Container(
              constraints: const BoxConstraints(minWidth: 16),
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
              decoration: BoxDecoration(color: p.fg.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(8)),
              child: Text(
                '$count',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 10, height: 1.3, color: p.fg.withValues(alpha: 0.75), fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 连不上电脑、或 herdr 没在运行。
/// 有新版本：一条可以关掉的提示，点「更新」下载安装包（下载完成后点通知安装）。
class _UpdateBanner extends StatelessWidget {
  final String version;
  final VoidCallback onUpdate;
  final VoidCallback onDismiss;
  const _UpdateBanner({required this.version, required this.onUpdate, required this.onDismiss});

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
      decoration: BoxDecoration(color: p.done.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
      child: Row(
        children: [
          Icon(Icons.system_update_rounded, size: 18, color: p.done),
          const SizedBox(width: 8),
          Expanded(child: Text('有新版本 $version', style: TextStyle(fontSize: 13, color: p.done))),
          TextButton(onPressed: onUpdate, child: const Text('更新')),
          IconButton(onPressed: onDismiss, icon: Icon(Icons.close_rounded, size: 18, color: p.mutedFg), tooltip: '这次不提示'),
        ],
      ),
    );
  }
}

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
      child: Row(
        children: [
          Icon(herdrDown ? Icons.terminal_rounded : Icons.cloud_off_rounded, size: 18, color: p.destructive),
          const SizedBox(width: 8),
          Expanded(
            child: Text(herdrDown ? 'herdr 没有在运行' : '正在连接电脑…', style: TextStyle(fontSize: 13, color: p.destructive)),
          ),
          if (herdrDown) TextButton(onPressed: () => run(context, app.api.startHerdr), child: const Text('启动 herdr')),
        ],
      ),
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
      return ListView(
        children: [
          header,
          const _Empty(icon: Icons.folder_open_rounded, text: '还没有项目'),
        ],
      );
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
    final app = AppScope.read(context);
    HapticFeedback.lightImpact();
    final paneId = await run(context, () => app.api.startSession(project.id, kind));
    if (paneId != null && context.mounted) openSession(context, paneId);
  }

  Future<void> _editNote(BuildContext context) async {
    final v = await promptText(context, title: '项目备注', initial: project.note ?? '', hint: '给「${project.name}」写个备注，留空清除');
    if (v == null || v == (project.note ?? '') || !context.mounted) return;
    await run(context, () => AppScope.read(context).api.updateProject(project.id, {'note': v}));
  }

  void _menu(BuildContext context) {
    final app = AppScope.read(context);
    final available = availableAgentKinds(AppScope.read(context).overview);
    final starters = [
      if (available.contains(project.defaultAgent)) project.defaultAgent,
      ...available.where((k) => k != project.defaultAgent),
    ];
    showActions(
      context,
      title: project.note ?? project.name,
      subtitle: shortPath(project.path),
      actions: [
        SheetAction(Icons.edit_note_rounded, project.note == null ? '添加备注' : '修改备注', () => _editNote(context)),
        SheetAction(Icons.folder_open_rounded, '文件', () => FilesPage.open(context, project)),
        for (final k in starters) SheetAction(Icons.add_rounded, '新开 ${kindLabel[k]}', () => _start(context, k)),
        SheetAction(Icons.terminal_rounded, '新开临时终端', () => _start(context, SessionKind.shell)),
        SheetAction(Icons.copy_rounded, '复制路径', () {
          Clipboard.setData(ClipboardData(text: project.path));
          toast(context, '已复制');
        }),
        SheetAction(
          project.notify ? Icons.notifications_off_outlined : Icons.notifications_outlined,
          project.notify ? '不推送这个项目的通知' : '推送这个项目的通知',
          () => run(context, () => app.api.updateProject(project.id, {'notify': !project.notify})),
        ),
        SheetAction(Icons.archive_outlined, '归档项目', () => run(context, () => app.api.updateProject(project.id, {'archived': true}), success: '已归档')),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    final sorted = sortProjectSessions(sessions, sort);
    final regular = sorted.where((s) => !s.isHarness).toList();
    final harness = sorted.where((s) => s.isHarness).toList();
    final available = availableAgentKinds(AppScope.read(context).overview);
    final starters = [
      if (available.contains(project.defaultAgent)) project.defaultAgent,
      ...available.where((k) => k != project.defaultAgent),
    ];
    // 行内只留默认 agent 和 DeepSeek，其余仍在长按菜单里。
    final inlineStarters = starters.where((k) => k == project.defaultAgent || k == SessionKind.harness).toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 6, 4, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onLongPress: () {
              HapticFeedback.mediumImpact();
              _menu(context);
            },
            onDoubleTap: () => _editNote(context),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 6, 4, 6),
              child: Row(
                children: [
                  // 备注醒目地显示在最上面，文件夹名和路径退到下面一行
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        AnimatedSize(
                          duration: const Duration(milliseconds: 200),
                          alignment: Alignment.topLeft,
                          child: Text(
                            project.note ?? project.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: project.note != null ? 18 : 15, fontWeight: FontWeight.w600, height: 1.3),
                          ),
                        ),
                        Text.rich(
                          TextSpan(
                            children: [
                              if (project.note != null)
                                TextSpan(
                                  text: '${project.name} · ',
                                  style: TextStyle(color: p.fg.withValues(alpha: 0.7), fontWeight: FontWeight.w500),
                                ),
                              TextSpan(
                                text: shortPath(project.path),
                                style: const TextStyle(fontFamily: mono),
                              ),
                            ],
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11, color: p.mutedFg),
                        ),
                      ],
                    ),
                  ),
                  _IconTap(
                    tooltip: '文件',
                    onTap: () => FilesPage.open(context, project),
                    child: Icon(Icons.folder_open_rounded, size: 20, color: p.folder),
                  ),
                  _IconTap(
                    tooltip: '更多',
                    onTap: () => _menu(context),
                    child: Icon(Icons.more_horiz_rounded, size: 20, color: p.mutedFg),
                  ),
                  if (dragIndex != null)
                    ReorderableDragStartListener(
                      index: dragIndex!,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
                        child: Icon(Icons.drag_indicator_rounded, size: 20, color: p.mutedFg),
                      ),
                    ),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(left: 6),
            child: Wrap(
              children: [
                for (final k in inlineStarters)
                  _IconTap(
                    tooltip: '新开 ${kindLabel[k]}',
                    onTap: () => _start(context, k),
                    child: AgentIcon(kind: k, size: 24),
                  ),
                _IconTap(
                  tooltip: '新开临时终端',
                  onTap: () => _start(context, SessionKind.shell),
                  child: const AgentIcon(kind: SessionKind.shell, size: 24),
                ),
              ],
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
                : Column(
                    children: [
                      for (final s in regular) SessionTile(key: ValueKey(s.paneId), session: s, project: project),
                      _HarnessGroup(sessions: harness, project: project),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

/// 项目 / 未归属里的 DeepSeek 会话折成一组，默认收起；点一下展开。
class _HarnessGroup extends StatefulWidget {
  final List<Session> sessions;
  final Project? project;
  const _HarnessGroup({required this.sessions, this.project});

  @override
  State<_HarnessGroup> createState() => _HarnessGroupState();
}

class _HarnessGroupState extends State<_HarnessGroup> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    if (widget.sessions.isEmpty) return const SizedBox.shrink();
    final p = Palette.of(context);
    return Column(
      children: [
        InkWell(
          borderRadius: BorderRadius.circular(10),
          onTap: () => setState(() => _open = !_open),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
            child: Row(
              children: [
                const AgentIcon(kind: SessionKind.harness, size: 22),
                const SizedBox(width: 10),
                const Expanded(child: Text('DeepSeek', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500))),
                Text('${widget.sessions.length} 个会话', style: TextStyle(fontSize: 12, color: p.mutedFg)),
                const SizedBox(width: 4),
                Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded, size: 20, color: p.mutedFg),
              ],
            ),
          ),
        ),
        if (_open)
          for (final s in widget.sessions) SessionTile(key: ValueKey(s.paneId), session: s, project: widget.project),
      ],
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
    child: InkResponse(
      onTap: onTap,
      radius: 22,
      child: Padding(padding: const EdgeInsets.all(8), child: child),
    ),
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
    final regular = sorted.where((s) => !s.isHarness).toList();
    final harness = sorted.where((s) => s.isHarness).toList();
    Future<void> start(SessionKind kind) async {
      HapticFeedback.lightImpact();
      final paneId = await run(context, () => app.api.startUnassignedSession(kind));
      if (paneId != null && context.mounted) openSession(context, paneId);
    }

    // 新开会话：和项目一样直接点图标，在主目录里启动，不属于任何项目
    final starters = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
          for (final k in availableAgentKinds(app.overview))
            _IconTap(tooltip: '新开 ${kindLabel[k]}（在主目录）', onTap: () => start(k), child: AgentIcon(kind: k, size: 24)),
          _IconTap(
            tooltip: '新开终端（在主目录）',
            onTap: () => start(SessionKind.shell),
            child: const AgentIcon(kind: SessionKind.shell, size: 24),
          ),
      ],
    );
    // 空间足够时排序和创建入口同一行；窄屏自动换行。
    final header = Padding(
      padding: const EdgeInsets.fromLTRB(12, 2, 4, 4),
      child: Wrap(
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 8,
        runSpacing: 4,
        children: [
          SegmentedSwitch(value: sort, options: unassignedSortLabels, onChanged: (v) => app.unassignedSort = v),
          starters,
        ],
      ),
    );
    if (sorted.isEmpty) {
      return ListView(
        children: [
          header,
          const _Empty(icon: Icons.inbox_rounded, text: '没有未归属的会话'),
        ],
      );
    }
    if (sort != UnassignedSort.herdr) {
      return ListView(
        padding: const EdgeInsets.fromLTRB(4, 0, 4, 32),
        children: [
          header,
          for (final s in regular) SessionTile(key: ValueKey(s.paneId), session: s),
          _HarnessGroup(sessions: harness),
        ],
      );
    }
    // herdr 顺序：按住右侧把手拖动，电脑上 herdr 的侧栏同步调整
    return ReorderableListView.builder(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 32),
      header: header,
      buildDefaultDragHandles: false,
      itemCount: regular.length,
      footer: _HarnessGroup(sessions: harness),
      proxyDecorator: (child, _, _) => Material(color: p.card, elevation: 6, borderRadius: BorderRadius.circular(12), child: child),
      onReorderItem: (from, to) {
        final list = [...regular];
        final moved = list.removeAt(from);
        if (moved.isHarness) return;
        list.insert(to, moved);
        final i = list.indexOf(moved);
        final before = list.skip(i + 1).where((s) => !s.isHarness).firstOrNull;
        run(context, () => app.api.moveBefore(moved.paneId, before?.paneId));
      },
      itemBuilder: (context, i) => SessionTile(
        key: ValueKey(regular[i].paneId),
        session: regular[i],
        handle: ReorderableDragStartListener(
          index: i,
          child: Padding(
            padding: const EdgeInsets.only(left: 8),
            child: Icon(Icons.drag_indicator_rounded, size: 20, color: p.mutedFg),
          ),
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
    return ListView(
      padding: const EdgeInsets.fromLTRB(4, 4, 4, 32),
      children: [
        for (final a in overview.archived)
          ListTile(
            leading: AgentIcon(kind: a.kind),
            title: Text(a.title, maxLines: 1, overflow: TextOverflow.ellipsis),
            subtitle: Text(
              a.projectId != null ? (names[a.projectId] ?? '已删除的项目') : shortPath(a.cwd),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, color: p.mutedFg),
            ),
            onTap: () async {
              final paneId = await run(context, () => app.api.restore(a.id));
              if (paneId != null && context.mounted) openSession(context, paneId);
            },
            onLongPress: () => showActions(
              context,
              title: a.title,
              subtitle: shortPath(a.cwd),
              actions: [
                SheetAction(Icons.unarchive_outlined, '恢复（继续这个对话）', () async {
                  final paneId = await run(context, () => app.api.restore(a.id));
                  if (paneId != null && context.mounted) openSession(context, paneId);
                }),
                SheetAction(Icons.delete_outline_rounded, '删除归档记录', () async {
                  if (await confirm(context, title: '删除这条归档记录？', body: '只删除 projdeck 里的记录，对话文件本身不会删除。', action: '删除', destructive: true) &&
                      context.mounted) {
                    run(context, () => app.api.deleteArchive(a.id));
                  }
                }, destructive: true),
              ],
            ),
          ),
        if (archivedProjects.isNotEmpty) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Text('归档的项目', style: TextStyle(fontSize: 12, color: p.mutedFg)),
          ),
          for (final pr in archivedProjects)
            ListTile(
              leading: Icon(Icons.folder_outlined, color: p.folder),
              title: Text(pr.note ?? pr.name),
              subtitle: Text(
                shortPath(pr.path),
                style: TextStyle(fontSize: 12, color: p.mutedFg, fontFamily: mono),
              ),
              trailing: TextButton(onPressed: () => run(context, () => app.api.updateProject(pr.id, {'archived': false})), child: const Text('恢复')),
            ),
        ],
      ],
    );
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
      child: Column(
        children: [
          Icon(icon, size: 36, color: p.mutedFg),
          const SizedBox(height: 10),
          Text(text, style: TextStyle(color: p.mutedFg)),
        ],
      ),
    );
  }
}
