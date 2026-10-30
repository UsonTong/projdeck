import 'api/models.dart';

// 列表顺序，与网页的 lib/sessionOrder.ts 一致（会话页左右滑切换也按这个顺序）。

enum ProjectSort { custom, recent, status }

enum UnassignedSort { herdr, recent, status }

const projectSortLabels = {ProjectSort.custom: '自定义', ProjectSort.recent: '最近活动', ProjectSort.status: '状态'};
const unassignedSortLabels = {UnassignedSort.herdr: 'herdr 顺序', UnassignedSort.recent: '最近活动', UnassignedSort.status: '状态'};

/// 越需要关注越靠前：需处理 > 工作中 > 已完成 > 其他。
int statusRank(Session s) => switch (s.status) {
  SessionStatus.blocked => 0,
  SessionStatus.working => 1,
  SessionStatus.done => 2,
  SessionStatus.idle => 3,
  SessionStatus.unknown => 4,
};

int _projectRank(Project p) => p.sessions.where((s) => !s.hidden).map(statusRank).fold(5, (a, b) => a < b ? a : b);
int _projectActiveAt(Project p) => p.sessions.where((s) => !s.hidden).map((s) => s.activeAt ?? 0).fold(0, (a, b) => a > b ? a : b);

List<Project> sortProjects(List<Project> projects, ProjectSort mode) {
  final list = projects.where((p) => !p.archived).toList();
  int byName(Project a, Project b) => a.name.compareTo(b.name);
  switch (mode) {
    case ProjectSort.custom:
      list.sort((a, b) {
        final c = (a.order ?? 1 << 30).compareTo(b.order ?? 1 << 30);
        return c != 0 ? c : byName(a, b);
      });
    case ProjectSort.recent:
      list.sort((a, b) {
        final c = _projectActiveAt(b).compareTo(_projectActiveAt(a));
        return c != 0 ? c : byName(a, b);
      });
    case ProjectSort.status:
      list.sort((a, b) {
        final c = _projectRank(a).compareTo(_projectRank(b));
        return c != 0 ? c : byName(a, b);
      });
  }
  return list;
}

List<Session> sortProjectSessions(List<Session> sessions, ProjectSort mode) {
  final list = [...sessions];
  int byOrder(Session a, Session b) => a.order.compareTo(b.order);
  switch (mode) {
    case ProjectSort.recent:
      list.sort((a, b) {
        final c = (b.activeAt ?? 0).compareTo(a.activeAt ?? 0);
        return c != 0 ? c : byOrder(a, b);
      });
    case ProjectSort.custom:
      list.sort(byOrder);
    case ProjectSort.status:
      list.sort((a, b) {
        final c = statusRank(a).compareTo(statusRank(b));
        return c != 0 ? c : byOrder(a, b);
      });
  }
  return list;
}

List<Session> sortUnassigned(List<Session> sessions, UnassignedSort mode) {
  final list = [...sessions];
  int byOrder(Session a, Session b) => a.order.compareTo(b.order);
  switch (mode) {
    case UnassignedSort.recent:
      list.sort((a, b) {
        final c = (b.activeAt ?? 0).compareTo(a.activeAt ?? 0);
        return c != 0 ? c : byOrder(a, b);
      });
    case UnassignedSort.status:
      list.sort((a, b) {
        final c = statusRank(a).compareTo(statusRank(b));
        return c != 0 ? c : byOrder(a, b);
      });
    case UnassignedSort.herdr:
      list.sort(byOrder);
  }
  return list;
}

/// 列表里从上到下的全部会话（不含隐藏的）：先各项目，再未归属。
List<Session> navigationOrder(Overview o, ProjectSort ps, UnassignedSort us) => [
  for (final p in sortProjects(o.projects, ps)) ...sortProjectSessions(p.sessions.where((s) => !s.hidden).toList(), ps),
  ...sortUnassigned(o.unassigned.where((s) => !s.hidden).toList(), us),
];
