import 'package:flutter/material.dart';

/// 全屏看图：双指缩放、拖动，点一下或返回键关闭。
class ImageViewer extends StatelessWidget {
  final ImageProvider image;
  final String? title;
  final List<Widget> actions;
  const ImageViewer({super.key, required this.image, this.title, this.actions = const []});

  static void open(BuildContext context, ImageProvider image, {String? title, List<Widget> actions = const []}) {
    Navigator.of(context).push(
      PageRouteBuilder(
        opaque: false,
        barrierColor: Colors.black,
        transitionDuration: const Duration(milliseconds: 200),
        pageBuilder: (_, _, _) => ImageViewer(image: image, title: title, actions: actions),
        transitionsBuilder: (_, a, _, child) => FadeTransition(opacity: a, child: child),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: title == null ? null : Text(title!, style: const TextStyle(fontSize: 15)),
        actions: actions,
      ),
      body: GestureDetector(
        onTap: () => Navigator.pop(context),
        child: InteractiveViewer(
          maxScale: 8,
          child: Center(
            child: Image(
              image: image,
              loadingBuilder: (_, child, progress) => progress == null ? child : const CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
              errorBuilder: (_, _, _) => const Text('图片加载失败', style: TextStyle(color: Colors.white70)),
            ),
          ),
        ),
      ),
    );
  }
}
