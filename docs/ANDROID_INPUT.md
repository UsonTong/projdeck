# 安卓终端中文输入

## 问题与修复（2.5.2）

控制端仍使用 xterm 4 渲染和处理终端快捷键，但文字输入改由本地 `TerminalInput` 的 Flutter `TextInputClient` 管理。

确认的两个问题：

1. xterm 内部关闭 `enableSuggestions`，Android 会得到 `NO_SUGGESTIONS` 标志，部分中文输入法可能因此无法正常显示候选。
2. 原有输入逻辑假设每次输入都保留两个占位字符，提交时固定删除前两位。Widget 测试复现：直接提交“中文”会被截为空字符串，单字中文会被误判为删除。

本地适配：

- 使用正常可写的 TextInput 连接，开启候选，不启用自动纠错或个性化学习。
- 只在占位符实际存在时去掉它，不截断真实中文。
- composing 期间只显示候选前的组合文本，不提前把拼音字母发送给 shell。
- 支持提交当前词同时开始下一词、组合内退格、取消组合、空输入下的终端退格。
- 保留 xterm 的 Ctrl、方向键、Tab 等按键逻辑。点击终端时检查并恢复输入连接。

## 测试

```sh
cd packages/mobile
flutter analyze --no-pub
flutter test --no-pub
```

`test/terminal_input_test.dart` 覆盖原问题复现、中文提交、拼音组合、退格、回车、Ctrl-C、方向键与输入连接恢复。

这些测试验证输入协议和发给终端的数据，不等于验证了所有真机输入法。具体输入法的候选窗位置、外接键盘以及键盘收起/恢复仍需在手机上检查。不要通过切换成英文输入法或剪贴板粘贴来代替中文输入修复。

Harness 的原版输入框由 Android WebView 自己处理 IME，不经过 xterm；它与上述终端输入是两条独立链路。
