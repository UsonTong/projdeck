import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api/client.dart';
import '../theme.dart';

/// 第一次使用：粘贴电脑上 projdeck 的访问链接（`https://<地址>/k/<key>`）。
class LoginPage extends StatefulWidget {
  final Future<String?> Function(Connection conn) onConnect;
  final String? initial;
  const LoginPage({super.key, required this.onConnect, this.initial});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  late final _ctl = TextEditingController(text: widget.initial);
  String? _error;
  bool _busy = false;

  Future<void> _submit() async {
    final conn = Connection.parse(_ctl.text);
    if (conn == null) {
      setState(() => _error = '格式不对：应该是 https://<地址>/k/<访问 key>');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await widget.onConnect(conn);
    if (mounted) {
      setState(() {
        _busy = false;
        _error = err;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = Palette.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('projdeck', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                Text(
                  '粘贴电脑上 projdeck 的访问链接（形如 https://<地址>/k/<访问 key>，key 在电脑的 ~/.config/projdeck/edge-key）。只需要一次。',
                  style: TextStyle(color: p.mutedFg, height: 1.5),
                ),
                const SizedBox(height: 20),
                TextField(
                  controller: _ctl,
                  decoration: InputDecoration(
                    hintText: 'https://…/k/…',
                    errorText: _error,
                    suffixIcon: IconButton(
                      icon: const Icon(Icons.content_paste_rounded),
                      onPressed: () async => _ctl.text = (await Clipboard.getData('text/plain'))?.text ?? '',
                    ),
                  ),
                  keyboardType: TextInputType.url,
                  onSubmitted: (_) => _submit(),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy ? null : _submit,
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                  child: _busy ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('连接'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
