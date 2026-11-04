import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:mime/mime.dart';

import 'models.dart';

/// 要上传的文件（从相册、文件管理器选的，或剪贴板、输入法里的图片）。
class LocalFile {
  final String name;
  final int length;
  final Stream<List<int>> Function() open;
  final String mime;

  /// 图片的内容（用来显示缩略图）；其他文件为 null。
  final Uint8List? preview;

  LocalFile({required this.name, required this.length, required this.open, String? mime, this.preview})
    : mime = mime ?? lookupMimeType(name) ?? 'application/octet-stream';

  factory LocalFile.bytes(String name, Uint8List bytes, {String? mime}) {
    final m = mime ?? lookupMimeType(name, headerBytes: bytes) ?? 'application/octet-stream';
    return LocalFile(name: name, length: bytes.length, open: () => Stream.value(bytes), mime: m, preview: m.startsWith('image/') ? bytes : null);
  }

  bool get isImage => mime.startsWith('image/');
  bool get isVideo => mime.startsWith('video/');
}

/// 上传后的文件：本地绝对路径（发给 agent 的消息里附上它）。
class Uploaded {
  final String path;
  final String name;
  final bool image;
  Uploaded.fromJson(Map<String, dynamic> j) : path = j['path'], name = j['name'] ?? '', image = j['image'] == true;
}

class FileEntry {
  final String name;
  final bool dir;
  final int size;
  final String modifiedAt;
  FileEntry.fromJson(Map<String, dynamic> j)
    : name = j['name'],
      dir = j['type'] == 'dir',
      size = (j['size'] as num?)?.toInt() ?? 0,
      modifiedAt = j['modifiedAt'] ?? '';
}

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
  /// 不属于任何项目的新会话（在主目录里启动）。
  Future<String> startUnassignedSession(SessionKind kind) async => (await post('/api/sessions', {'kind': kind.name}))['paneId'];
  Future<void> setHidden(String paneId, bool hidden) => post('${pane(paneId)}/hidden', {'hidden': hidden});
  Future<void> rename(String paneId, String? label) => post('${pane(paneId)}/rename', {'label': label});
  Future<void> archive(String paneId) => post('${pane(paneId)}/archive');
  Future<void> close(String paneId) => post('${pane(paneId)}/close');
  Future<void> moveToProject(String paneId, String projectId) => post('${pane(paneId)}/project', {'projectId': projectId});
  Future<void> moveBefore(String paneId, String? beforePaneId) => post('${pane(paneId)}/move-before', {'beforePaneId': beforePaneId});
  Future<void> prompt(String paneId, String text, List<String> files) => post('${pane(paneId)}/prompt', {'text': text, 'files': files});
  Future<void> keys(String paneId, List<String> keys) => post('${pane(paneId)}/keys', {'keys': keys});
  Future<void> cancel(String paneId) => post('${pane(paneId)}/cancel');

  /// 服务器上发布的安卓 App 版本（没有发布过返回 null）。
  Future<Map<String, dynamic>?> androidApp() async {
    final v = await get('/api/app');
    return v is Map ? v.cast<String, dynamic>() : null;
  }

  Future<void> updateProject(String id, Map<String, Object?> body) => patch('/api/projects/$id', body);
  Future<void> reorderProjects(List<String> ids) => post('/api/projects/order', {'ids': ids});
  Future<String> restore(String archiveId) async => (await post('/api/archive/$archiveId/restore'))['paneId'];
  Future<void> deleteArchive(String archiveId) => delete('/api/archive/$archiveId');
  Future<void> startHerdr() => post('/api/herdr/start');
  Future<void> notifyTest() => post('/api/notify/test');

  // ---- 上传 ----

  Future<dynamic> _upload(String path, List<LocalFile> files) async {
    final req = http.MultipartRequest('POST', conn.url(path))..headers.addAll(conn.headers);
    for (final f in files) {
      req.files.add(http.MultipartFile('file', http.ByteStream(f.open()), f.length, filename: f.name, contentType: MediaType.parse(f.mime)));
    }
    final res = await http.Response.fromStream(await _http.send(req));
    final data = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    if (res.statusCode >= 400) throw ApiError(res.statusCode, data is Map && data['error'] is String ? data['error'] : '上传失败（${res.statusCode}）');
    return data;
  }

  /// 会话的附件：属于项目时存到项目的 .uploads/，返回电脑上的路径。
  Future<Uploaded> uploadForSession(String paneId, LocalFile f) async => Uploaded.fromJson(await _upload('${pane(paneId)}/uploads', [f]));

  // ---- 项目文件（路径为项目内的相对路径） ----

  static String files(String projectId) => '/api/projects/${Uri.encodeComponent(projectId)}/files';
  static String q(String path) => Uri.encodeQueryComponent(path);

  Future<List<FileEntry>> listDir(String projectId, String path, {bool hidden = false}) async {
    final r = await get('${files(projectId)}?path=${q(path)}&hidden=${hidden ? 1 : 0}');
    return [for (final e in (r['entries'] as List)) FileEntry.fromJson(e)];
  }

  /// 文字文件的内容；二进制文件返回 null。
  Future<({String text, bool truncated})?> readText(String projectId, String path) async {
    final r = await get('${files(projectId)}/text?path=${q(path)}');
    if (r['binary'] == true) return null;
    return (text: r['text'] as String, truncated: r['truncated'] == true);
  }

  Future<({String text, int mtimeMs})> readForEdit(String projectId, String path) async {
    final r = await get('${files(projectId)}/edit?path=${q(path)}');
    return (text: r['text'] as String, mtimeMs: (r['mtimeMs'] as num).toInt());
  }

  /// 保存；文件在打开之后被改过时抛出 409（baseMtimeMs 为 null 表示确认覆盖）。
  Future<int> saveFile(String projectId, String path, String text, int? baseMtimeMs) async =>
      ((await _send('PUT', '${files(projectId)}/edit', {'path': path, 'text': text, 'baseMtimeMs': baseMtimeMs}))['mtimeMs'] as num).toInt();

  Future<void> uploadToDir(String projectId, String dir, List<LocalFile> list) => _upload('${files(projectId)}/upload?path=${q(dir)}', list);
  Future<void> mkdir(String projectId, String dir, String name) => post('${files(projectId)}/mkdir', {'path': dir, 'name': name});
  Future<void> renameFile(String projectId, String path, String name) => post('${files(projectId)}/rename', {'path': path, 'name': name});
  Future<void> deleteFile(String projectId, String path) => delete('${files(projectId)}?path=${q(path)}');
  Uri rawUrl(String projectId, String path) => conn.url('${files(projectId)}/raw?path=${q(path)}');
  Uri downloadUrl(String projectId, String path) => conn.url('${files(projectId)}/download?path=${q(path)}');

  /// 对话里的图片缩略图（只允许项目内的图片）。
  Uri imageUrl(String projectId, String absPath) => conn.url('/api/file?project=${Uri.encodeQueryComponent(projectId)}&path=${q(absPath)}');
}
