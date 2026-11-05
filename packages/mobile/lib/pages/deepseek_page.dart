import 'package:flutter/material.dart';

import '../api/models.dart';
import '../native.dart';
import '../state.dart';
import '../theme.dart';
import '../widgets/agent_icon.dart';
import '../widgets/session_tile.dart';

/// 所有 DeepSeek 对话的总览，不按项目分组；有标题的真实对话排在空会话前面，
/// 避免同名空会话把历史埋在列表里。
class DeepSeekPage extends StatelessWidget {
  const DeepSeekPage({super.key});

  static void open(BuildContext context) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => const DeepSeekPage()));

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final p = Palette.of(context);
    final o = app.overview;
    final sessions = o == null
        ? <Session>[]
        : [...o.projects.expand((project) => project.sessions), ...o.unassigned]
              .where((s) => s.kind == SessionKind.harness)
              .toList()
          ..sort((a, b) {
            final blank = (a.title.startsWith('空会话') ? 1 : 0).compareTo(b.title.startsWith('空会话') ? 1 : 0);
            return blank != 0 ? blank : (b.activeAt ?? 0).compareTo(a.activeAt ?? 0);
          });
    String projectOf(Session s) =>
        o?.projects.where((project) => project.sessions.any((x) => x.paneId == s.paneId)).firstOrNull?.name ?? '未归属';
    return Scaffold(
      appBar: AppBar(
        title: const Text('DeepSeek 对话'),
        actions: [
          if (o?.harness?.configured == true)
            IconButton(
              tooltip: '打开原版 Harness 网页',
              icon: const Icon(Icons.open_in_new_rounded),
              onPressed: () => Native.openHarnessWeb(app.conn),
            ),
        ],
      ),
      body: o?.harness?.configured != true
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text('请先在电脑上的 projdeck 网页「设置 → DeepSeek Harness」里接入。', textAlign: TextAlign.center, style: TextStyle(color: p.mutedFg)),
              ),
            )
          : sessions.isEmpty
          ? Center(child: Text('还没有 DeepSeek 对话', style: TextStyle(color: p.mutedFg)))
          : ListView.separated(
              padding: const EdgeInsets.fromLTRB(8, 8, 8, 32),
              itemCount: sessions.length,
              separatorBuilder: (_, _) => const Divider(height: 1, indent: 56),
              itemBuilder: (context, i) {
                final s = sessions[i];
                final blank = s.title.startsWith('空会话');
                return ListTile(
                  leading: const AgentIcon(kind: SessionKind.harness, size: 34),
                  title: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: blank ? p.mutedFg : null)),
                  subtitle: Text(
                    '${projectOf(s)} · ${s.cwd}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, color: p.mutedFg),
                  ),
                  onTap: () => openSession(context, s.paneId),
                );
              },
            ),
    );
  }
}
