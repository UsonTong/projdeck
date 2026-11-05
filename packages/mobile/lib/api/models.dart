// 与 packages/shared/src/index.ts 对应的数据结构（只取 App 用到的字段）。

enum SessionKind { claude, codex, pi, shell, harness }

enum SessionStatus { working, idle, blocked, done, unknown }

SessionKind _kind(String? s) => SessionKind.values.firstWhere((k) => k.name == s, orElse: () => SessionKind.shell);
SessionStatus _status(String? s) => SessionStatus.values.firstWhere((k) => k.name == s, orElse: () => SessionStatus.unknown);

class SessionCapabilities {
  final bool terminal;
  final bool chat;
  final bool keys;

  SessionCapabilities.fromJson(Map<String, dynamic> j)
    : terminal = j['terminal'] == true,
      chat = j['chat'] == true,
      keys = j['keys'] == true;
}

class Session {
  final String paneId;
  final String terminalId;
  final String workspaceId;
  final String backend;
  final SessionCapabilities? capabilities;
  final SessionKind kind;
  final SessionStatus status;
  final String title;
  final String cwd;
  final String? conversationId;
  final bool hidden;
  final int order;
  final int? activeAt;
  final bool renamed;
  final String? restoreError;

  Session.fromJson(Map<String, dynamic> j)
    : paneId = j['paneId'],
      terminalId = j['terminalId'] ?? '',
      workspaceId = j['workspaceId'] ?? '',
      backend = j['backend'] ?? (j['kind'] == 'harness' ? 'harness' : 'herdr'),
      capabilities = j['capabilities'] is Map<String, dynamic> ? SessionCapabilities.fromJson(j['capabilities']) : null,
      kind = _kind(j['kind']),
      status = _status(j['status']),
      title = j['title'] ?? '',
      cwd = j['cwd'] ?? '',
      conversationId = j['conversationId'],
      hidden = j['hidden'] == true,
      order = (j['order'] as num?)?.toInt() ?? 0,
      activeAt = (j['activeAt'] as num?)?.toInt(),
      renamed = j['renamed'] == true,
      restoreError = j['restoreError'];

  bool get isHarness => backend == 'harness' || kind == SessionKind.harness || paneId.startsWith('harness:');
  bool get supportsTerminal => !isHarness && (capabilities?.terminal ?? true);
  bool get supportsChat => capabilities?.chat ?? (kind != SessionKind.shell);
  bool get supportsKeys => supportsTerminal && (capabilities?.keys ?? true);
}

class Project {
  final String id;
  final String name;
  final String path;
  final bool archived;
  final SessionKind defaultAgent;
  final bool notify;
  final String? note;
  final int? order;
  final List<Session> sessions;

  Project.fromJson(Map<String, dynamic> j)
    : id = j['id'],
      name = j['name'] ?? '',
      path = j['path'] ?? '',
      archived = j['archived'] == true,
      defaultAgent = _kind(j['defaultAgent']),
      notify = j['notify'] != false,
      note = (j['note'] as String?)?.isNotEmpty == true ? j['note'] : null,
      order = (j['order'] as num?)?.toInt(),
      sessions = [for (final s in (j['sessions'] as List? ?? [])) Session.fromJson(s)];
}

class ArchivedSession {
  final String id;
  final String? projectId;
  final SessionKind kind;
  final String title;
  final String cwd;
  final String archivedAt;

  ArchivedSession.fromJson(Map<String, dynamic> j)
    : id = j['id'],
      projectId = j['projectId'],
      kind = _kind(j['kind']),
      title = j['title'] ?? '',
      cwd = j['cwd'] ?? '',
      archivedAt = j['archivedAt'] ?? '';
}

class HarnessStatus {
  final bool configured;
  final bool online;
  final String? error;

  HarnessStatus.fromJson(Map<String, dynamic> j)
    : configured = j['configured'] == true,
      online = j['online'] == true,
      error = j['error'];
}

class PresentedResource {
  final String id;
  final String name;
  final String title;
  final String mime;
  final int at;
  final String url;
  final String path;

  PresentedResource.fromJson(Map<String, dynamic> j)
    : id = j['id'],
      name = j['name'] ?? '',
      title = j['title'] ?? '',
      mime = j['mime'] ?? '',
      at = (j['at'] as num?)?.toInt() ?? 0,
      url = j['url'] ?? '',
      path = j['path'] ?? '';
}

class Overview {
  final HarnessStatus? harness;
  final bool herdrOnline;
  final String? herdrError;
  final List<Project> projects;
  final List<Session> unassigned;
  final List<ArchivedSession> archived;
  final String? timeZone;
  final bool autoTrust;

  Overview.fromJson(Map<String, dynamic> j)
    : harness = j['harness'] is Map<String, dynamic> ? HarnessStatus.fromJson(j['harness']) : null,
      herdrOnline = j['herdr']?['online'] == true,
      herdrError = j['herdr']?['error'],
      projects = [for (final p in (j['projects'] as List? ?? [])) Project.fromJson(p)],
      unassigned = [for (final s in (j['unassigned'] as List? ?? [])) Session.fromJson(s)],
      archived = [for (final a in (j['archived'] as List? ?? [])) ArchivedSession.fromJson(a)],
      timeZone = j['settings']?['timeZone'],
      autoTrust = j['settings']?['autoTrust'] != false;

  /// 按 paneId 找会话和它所在的项目。
  (Session, Project?)? find(String paneId) {
    for (final p in projects) {
      for (final s in p.sessions) {
        if (s.paneId == paneId) return (s, p);
      }
    }
    for (final s in unassigned) {
      if (s.paneId == paneId) return (s, null);
    }
    return null;
  }
}

/// 本机 Ghostty 的配色，整个 App 的颜色由它推出来（与网页一致）。
class TerminalTheme {
  final String background;
  final String foreground;
  final String cursor;
  final String cursorText;
  final String selectionBackground;
  final String selectionForeground;
  final List<String> palette;

  TerminalTheme.fromJson(Map<String, dynamic> j)
    : background = j['background'] ?? '#0a0a0a',
      foreground = j['foreground'] ?? '#e5e5e5',
      cursor = j['cursor'] ?? '#e5e5e5',
      cursorText = j['cursorText'] ?? '#0a0a0a',
      selectionBackground = j['selectionBackground'] ?? '#404040',
      selectionForeground = j['selectionForeground'] ?? '#e5e5e5',
      palette = [for (final c in (j['palette'] as List? ?? [])) c as String];

  static TerminalTheme get fallback => TerminalTheme.fromJson({});
}

// ---- 对话记录（气泡） ----

sealed class TranscriptEntry {
  final String id;
  final String? time;
  TranscriptEntry(this.id, this.time);

  static TranscriptEntry fromJson(Map<String, dynamic> j) => switch (j['kind']) {
    'user' => UserEntry(j['id'], j['time'], j['text'] ?? '', [for (final i in (j['images'] as List? ?? [])) i as String]),
    'assistant' => AssistantEntry(j['id'], j['time'], j['text'] ?? ''),
    _ => ToolEntry(j['id'], j['time'], j['name'] ?? '', j['summary'] ?? ''),
  };
}

class UserEntry extends TranscriptEntry {
  final String text;
  final List<String> images;
  UserEntry(super.id, super.time, this.text, this.images);
}

class AssistantEntry extends TranscriptEntry {
  final String text;
  AssistantEntry(super.id, super.time, this.text);
}

class ToolEntry extends TranscriptEntry {
  final String name;
  final String summary;
  ToolEntry(super.id, super.time, this.name, this.summary);
}
