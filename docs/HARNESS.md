# DeepSeek Harness 接入

Harness 不经过 herdr。默认入口现在直接显示现有 `dsh web` 的完整原版网页：网页使用同源 iframe，安卓控制端使用独立原生 WebView。herdr 仍负责 Claude、Codex、Pi 和临时终端。

原先重绘对话的结构化适配器保留用于旧 API 兼容与测试，但不再作为默认界面。

## 推荐：自启动并自动连接

本机已安装用户服务 `projdeck-harness.service`：

- 登录/开机由 systemd user 启动，崩溃后 5 秒自动重启。
- 使用现有 `~/.dsh` 的 web profile、模型配置和历史，不迁移数据。
- 只监听 `127.0.0.1:3081`，避免占用原来手动运行的 3080 实例；不开放额外公网端口。
- `deploy/harness/managed.mjs` 从 `dsh web:` 就绪行在内存接收启动链接，不把 token 写进 journal；自动原子更新 `harness.json`（0600），再通过本机管理接口让正在运行的 projdeck 切换连接。
- projdeck 尚未启动时每 15 秒重试；重新启动 Harness 后自动更新新 token，不再需要反复粘贴。
- `Wants=projdeck-agentd.service`、`After=projdeck-agentd.service` 保证启动顺序。`Linger=yes` 时不登录桌面也能运行，本机已开启。
- 管理器仅在内存读取 projdeck 的本机访问密钥，连接目标限制为 loopback HTTP，不读取 Harness 的账号或模型密钥文件。

安装（仓库默认位于 `~/Repositories/projdeck`）：

```sh
cp deploy/projdeck-harness.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now projdeck-harness.service
```

查看/停止/重启：

```sh
systemctl --user status projdeck-harness.service
systemctl --user restart projdeck-harness.service
systemctl --user disable --now projdeck-harness.service
```

验证：`node --test deploy/harness/managed.test.mjs`。测试使用假 CLI 与临时管理接口，不调用模型；本机另已验证托管服务重启后 token 变更、projdeck 自动接入以及原版网页恢复 200。没有重启整台电脑，没有停止原有手动 Harness 进程。

## 手动连接（不使用托管服务时）

1. 在运行 projdeck agentd 的电脑上运行 Harness（例如 `dsh web --no-open`），保留它原有的模型与 workspace 设置。
2. 打开 projdeck 网页「设置 → DeepSeek Harness」，粘贴 dsh 打印的本机启动链接（含 `?token=...`），点「接入」。不要把这个链接发到聊天、截图或 Git。
3. 网页左侧保留 projdeck 的项目/会话列表，Harness 会话折成「DeepSeek · N 个会话」一组（默认收起）；点击后右侧显示对应的原版聊天。项目旁 D 图标在这个项目目录的 Harness 工作区里新建会话；未归属的 D 使用 Harness 默认工作区。打开已有的空白会话时会自动把它加入目录对应的工作区，原版输入框不再要求选择工作区。已经开始过对话的旧会话没有公开的迁移接口，保持原样。
4. 原版导航列仅在嵌入模式隐藏，不重绘聊天。切换左侧 Harness 会话时复用 iframe，通过同源消息桥调用原版的 `uiWorkspace.openSession`，避免显示错误会话或反复下载前端。
5. 模型选择、权限确认、工具展示、附件等交互仍由原版网页处理；右上角「单独打开」使用 `/harness/`，保留完整原版侧栏。Harness 没有伪造的终端选项。
6. 安卓 2.5.3 的 Harness 会话在现有 `SessionPage` 内容区内嵌 Android WebView，使用 `/harness/?embed=1&session=<原会话ID>` 选择同一个会话；顶部 D 使用 `/harness/?embed=1` 只显示聊天（手机放不下 280px 原版侧栏）。更新改为 App 内下载并直接打开系统安装器，带进度，不再让用户从通知栏找安装包。

仅允许本机 loopback HTTP 地址（`localhost`、`127.0.0.1`、`[::1]`）。本次只支持一个 Harness Host，不支持把任意外部 URL 当代理。

## 凭据与权限

- Harness 的启动 token 与 projdeck 主密钥、被控端密钥均不同。
- 启动链接仅经已认证的 `PUT /api/harness` 请求体交给 agentd；状态与总览接口只返回 configured/online/脱敏错误，不返回 token。
- 同源 `/harness/*` 代理必须通过 projdeck 主登录认证；被控端密钥不能访问它。主密钥不转发给 Harness。
- 原版网页代理在后端使用启动 token 换取浏览器会话 Cookie，Cookie 仅在后端内存保存，不转发 Set-Cookie 给客户端。HTTP 与 WebSocket 都代理到同一个本机 Host，修改 Origin 为上游地址，保留 Host 自身的信任校验，不开放新公网端口。
- 代理保留原始请求体与查询串（尤其 `/plugins/??...` 组合资源）；不重绘消息、不修改原版安装文件、不自动同意权限。仅 `embed=1` 的启动 HTML 添加导航适配脚本。读请求认证失效可重试，写请求不自动重放。
- 只有带版本号的纯静态 JS/CSS/字体资源使用 private immutable 缓存；HTML、API、附件不缓存，手机切会话不必反复下载整个前端。
- 嵌入消息桥仅接受同源父窗口发来的会话 ID 和序号，不传 token、不执行任意脚本。安卓不使用 JS bridge，直接读取 URL 中的非敏感会话 ID。适配当前 `0.2.1-rc.2` 客户端模块协议，升级 Harness 后须回归；不支持时显示错误并提供完整原版入口。
- 安卓 WebView 不提供 JS bridge，禁止 file:// 与外站内嵌，密钥仅在受信任域的 HttpOnly Cookie 内设置。原版上传通过系统文件选择器返回 content URI。
- 连接配置保存在 `PROJDECK_CONFIG_DIR/harness.json`，默认 `~/.config/projdeck/harness.json`，权限 0600，不能提交。
- Harness 进程重启后，如果旧启动 token 不再有效，需要重新粘贴新的启动链接。projdeck 不会读取用户的 Harness `.credentials.yaml`、账号或模型密钥来绕过授权。
- 重试只自动恢复连接和读取；不会自动重发可能造成重复任务的 prompt/create 请求。

## 保留的结构化适配器（旧 API 兼容）

- `Session.backend` 与 `capabilities` 区分后端。为兼容现有路由，字段 `paneId` 对 Harness 表示 `harness:<sessionId>`，并不是 herdr pane。
- `terminalId/workspaceId` 是兼容字段：Harness 的 workspaceId 为空，不可用作 PTY 或 herdr 工作区目标。服务层会拒绝终端 attach、按键与 herdr 排序操作。
- `HarnessClient` 负责协议认证、HTTP RPC、`/api/remote.mux`、`session/follow`，并将事件映射到共享 transcript。
- 流式助手文字使用稳定消息 ID；文本修订发送 reset 全量快照，避免客户端按 ID 去重时丢掉更新。重连从原生 follow 快照和历史分页重建，不清空对话。
- LiveHub 向正在查看该会话的各端广播原生事件；herdr 会话仍使用现有 JSONL 增量读取。
- herdr 离线不阻止 Harness 显示。Harness 暂时离线保留本次 agentd 进程已知的会话列表，并标成未知状态；后端恢复后重连同步。第一次连接失败时不伪造历史列表。

## 结构化适配器的限制（不适用于原版网页）

- 支持文本会话、历史中的文本及工具结果、实时助手文字、停止生成、重命名、项目归属和 projdeck 本地归档。
- 尚未接入附件上传、图片/视频展示、原版的权限确认、子代理专用界面、模型选择 UI。附件入口对 Harness 隐藏，后端也明确拒绝，不会静默丢弃文件。
- 需要确认时回原版 Harness 界面处理，不会自动同意操作。
- 列表状态使用 Harness 的真实运行/可用状态；不是根据终端屏幕推测。没有完整接入原版所有状态投影与完成通知语义。
- 原版 Harness 的高级功能不因本次接入失效。协议按本机 `0.2.1-rc.2` 实现，升级 Harness 后需要回归验证。
- 原版客户端没有公开的「把已有非空会话移到另一个工作区」接口；projdeck 只能为新建会话指定工作区，并在打开空白会话时重新加入。移动 projdeck 里的归属只改变分组，不改变 Harness 工作目录。

## 验证

- 原版代理测试覆盖主密钥隔离、匿名/被控端拒绝访问、原始 JSON/二进制上传透传、组合插件查询串、重定向与 WebSocket 双向通信。
- 独立 DSH_HOME + 隔离 agentd + Chrome 实际验证原版前端加载成功、无资源 404，`/harness/api/remote.mux` 已连接，并查看截图确认原版侧栏和界面。没有调用模型；没有重启现有 Harness。
- Chrome 实际点击左侧两条隔离测试会话，确认右侧原版精确选中相应 ID、左侧 projdeck 保留、原版左栏宽度为 0，iframe 复用。没有调用模型。
- 导航桥单元测试覆盖 bootstrap/live 加载器切换、父窗口/Origin 校验、无效会话拒绝、安卓顶层 WebView 的 session 参数。
- 安卓 Flutter 检查、中文 IME/内嵌组件测试和 Kotlin 编译通过；真机 WebView 与文件选择尚未验证。
- 公网手机宽度实测：打开旧空白会话后自动加入 projdeck 工作区，工作区选择提示消失，聊天输入框可见，原版侧栏不占位；桌面项目行图标由 7 个减到 5 个，DeepSeek 会话折叠分组。
- 本地假 HTTP/WS Host 覆盖鉴权、Cookie、RPC、超时、拒绝凭据外流、历史分页、修订、partial assistant、断线补历史与关闭。
- 服务层集成测试在 herdr 离线时验证 Harness 创建、消息、历史、停止、归档/恢复，不调用 PTY。
- LiveHub 测试覆盖多客户端共享订阅、重新配置后订阅重建、取消后的资源释放。
- 另用独立 DSH_HOME 启动真实 Harness，与隔离 agentd 完成认证、创建、列表、历史与重命名，并在浏览器打开 Harness 设置和聊天页，确认不建立 `/ws/term`。没有读取真实用户凭据，也没有调用模型。
