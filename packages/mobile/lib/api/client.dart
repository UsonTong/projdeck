import 'dart:convert';
import 'package:http/http.dart' as http;
import 'models.dart';

class ApiError implements Exception {
  final int status;
  final String message;
  ApiError(this.status, this.message);
  @override
  String toString() => message;
}

/// 连接信息：电脑上 projdeck 的地址（公网入口）和访问 key。
class Connection {
  final Uri base;
  final String key;
  const Connection(this.base, this.key);

  /// 从访问链接 `https://<地址>/k/<key>` 解析。
  static Connection? parse(String link) {
    final uri = Uri.tryParse(link.trim());
    if (uri == null || uri.scheme != 'https' || uri.host.isEmpty) return null;
    final seg = uri.pathSegments;
    final i = seg.indexOf('k');
    if (i < 0 || i + 1 >= seg.length || seg[i + 1].isEmpty) return null;
    return Connection(Uri(scheme: 'https', host: uri.host, port: uri.port), seg[i + 1]);
  }

  Map<String, String> get headers => {'Cookie': 'projdeck_key=$key'};
  Uri url(String path) => base.resolve(path);
  Uri ws(String path) => url(path).replace(scheme: 'wss');
}

/// projdeck 的接口（与网页的 api.ts 对应）。
class Api {
  final Connection conn;
  final http.Client _http = http.Client();
  Api(this.conn);

  Future<dynamic> _send(String method, String path, [Object? body]) async {
    final req = http.Request(method, conn.url(path))..headers.addAll(conn.headers);
    if (body != null) {
      req.headers['Content-Type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    final res = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 30)));
    dynamic data;
    try {
      data = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      data = null;
    }
    if (res.statusCode >= 400) {
      final msg = data is Map && data['error'] is String ? data['error'] as String : '请求失败（${res.statusCode}）';
      throw ApiError(res.statusCode, res.statusCode == 404 && data == null ? '访问 key 无效或已更换' : msg);
    }
    return data;
  }

  Future<dynamic> get(String path) => _send('GET', path);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body ?? {});
  Future<dynamic> patch(String path, Object body) => _send('PATCH', path, body);
  Future<dynamic> delete(String path) => _send('DELETE', path);

  static String pane(String paneId) => '/api/sessions/${Uri.encodeComponent(paneId)}';

  Future<Overview> overview() async => Overview.fromJson(await get('/api/overview'));
  Future<TerminalTheme> terminalTheme() async => TerminalTheme.fromJson(await get('/api/terminal-theme'));

  Future<String> startSession(String projectId, SessionKind kind) async =>
      (await post('/api/projects/$projectId/sessions', {'kind': kind.name}))['paneId'];
  Future<void> setHidden(String paneId, bool hidden) => post('${pane(paneId)}/hidden', {'hidden': hidden});
  Future<void> rename(String paneId, String? label) => post('${pane(paneId)}/rename', {'label': label});
  Future<void> archive(String paneId) => post('${pane(paneId)}/archive');
  Future<void> close(String paneId) => post('${pane(paneId)}/close');
  Future<void> moveToProject(String paneId, String projectId) => post('${pane(paneId)}/project', {'projectId': projectId});
  Future<void> moveBefore(String paneId, String? beforePaneId) => post('${pane(paneId)}/move-before', {'beforePaneId': beforePaneId});
  Future<void> prompt(String paneId, String text, List<String> files) => post('${pane(paneId)}/prompt', {'text': text, 'files': files});
  Future<void> keys(String paneId, List<String> keys) => post('${pane(paneId)}/keys', {'keys': keys});

  Future<void> updateProject(String id, Map<String, Object?> body) => patch('/api/projects/$id', body);
  Future<void> reorderProjects(List<String> ids) => post('/api/projects/order', {'ids': ids});
  Future<String> restore(String archiveId) async => (await post('/api/archive/$archiveId/restore'))['paneId'];
  Future<void> deleteArchive(String archiveId) => delete('/api/archive/$archiveId');
  Future<void> startHerdr() => post('/api/herdr/start');
  Future<void> notifyTest() => post('/api/notify/test');
}
