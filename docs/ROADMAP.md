# 未来更新方向

按价值从高到低。做完一项就从这里删掉（或标注完成），细节写进对应的提交说明。

## 1. 安全加固（优先）

现在只靠访问链接（`/k/<key>`，cookie 有效期一年）把门，而 projdeck 能直接操作电脑上的终端，泄露即等于远程控制整台电脑。

- 第二道验证：新设备第一次登录时输密码，或在已登录的设备上点「允许」。
- 「已登录设备」列表：每台设备的类型、最近使用时间，一键踢下线。
- 一键更换访问 key（旧链接、旧 cookie 全部失效，nginx 入口同步更新）。
- 顺带评估 CC Switch 调试端口（127.0.0.1:47930，本机任何程序都能用它操控 CC Switch）。

## 2. 自动化测试进仓库

浏览器测试脚本一直放在 `/tmp/pdprobe`，重启就没了。把关键流程固定成测试（Playwright，跑在隔离的 `projdeck-test` herdr 会话里），部署前自动跑：
会话切换、终端（输入、尺寸、选区）、对话发消息和附件、文件管理器和编辑器、CC Switch（沙盒实例 + 独立 D-Bus）、手机布局和手势。

## 3. 每个会话的花费

CC Switch 的 `proxy_request_logs` 有 `session_id`，可以对应到 projdeck 的会话（Claude 的 conversationId / Codex 的 threadId）：
会话标题旁显示花费和 tokens，项目显示合计，找出特别烧钱的会话。网页和手机 App 都要有。

## 4. 快速切换和搜索（电脑）

Ctrl+K 搜索框：输入几个字跳到会话、项目、文件；搜索历史对话的内容。

## 5. 历史对话

Claude / Codex 本地保存着所有对话（不只是 herdr 里正在运行的和手动归档的）。做一个「历史」页，按项目列出，点一下恢复继续。

## 6. 清理和部署

- 删掉已被 Flutter App 取代的 WebView 外壳 `packages/android`。
- 处理工作区里未提交的隧道保活配置（`deploy/projdeck-tunnel.service`、`deploy/projdeck-sshd-keepalive.conf`）。
- 一个部署命令：编译网页 → 重启 agentd → 发布安卓 App（`packages/mobile/release.sh`）。
