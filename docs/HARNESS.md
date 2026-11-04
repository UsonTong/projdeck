# DeepSeek Harness 接入

Harness 是独立会话后端，不是 herdr agent。herdr 仍负责 Claude、Codex、Pi 和临时终端；agentd 直接连接本机 `dsh web` 的官方 RPC 和实时流。

## 使用

1. 在运行 projdeck agentd 的电脑上运行 Harness（例如 `dsh web --no-open`），保留它原有的模型与 workspace 设置。
2. 打开 projdeck 网页「设置 → DeepSeek Harness」，粘贴 dsh 打印的本机启动链接（含 `?token=...`），点「接入」。不要把这个链接发到聊天、截图或 Git。
3. 连接成功后，项目和未归属列表显示 DeepSeek 的 D 图标。原有 Harness 会话按工作目录匹配项目，没有匹配的放在未归属。
4. 点击 D 创建该项目目录下的会话；点击已有会话进入对话。消息与历史来自同一个 Harness Host，可与原版界面同时查看。
5. 停止生成、重命名、隐藏均可使用。归档会停止正在进行的任务，并在 projdeck 中隐藏它，不删除 Harness 的历史；恢复使用原 session id，不新建替代会话。删除 projdeck 归档记录也不删除 Harness 原始数据。

仅允许本机 loopback HTTP 地址（`localhost`、`127.0.0.1`、`[::1]`）。本次只支持一个 Harness Host，不支持把任意外部 URL 当代理。

## 凭据与权限

- Harness 的启动 token 与 projdeck 主密钥、被控端密钥均不同。
- 启动链接仅经已认证的 `PUT /api/harness` 请求体交给 agentd；状态与总览接口只返回 configured/online/脱敏错误，不返回 token。
- agentd 通过 `/connect` 换取 API peer Cookie，Cookie 只在后端内存里使用。不会让手机或网页直接连接 Harness 的端口。
- 连接配置保存在 `PROJDECK_CONFIG_DIR/harness.json`，默认 `~/.config/projdeck/harness.json`，权限 0600，不能提交。
- Harness 进程重启后，如果旧启动 token 不再有效，需要重新粘贴新的启动链接。projdeck 不会读取用户的 Harness `.credentials.yaml`、账号或模型密钥来绕过授权。
- 重试只自动恢复连接和读取；不会自动重发可能造成重复任务的 prompt/create 请求。

## 实现边界

- `Session.backend` 与 `capabilities` 区分后端。为兼容现有路由，字段 `paneId` 对 Harness 表示 `harness:<sessionId>`，并不是 herdr pane。
- `terminalId/workspaceId` 是兼容字段：Harness 的 workspaceId 为空，不可用作 PTY 或 herdr 工作区目标。服务层会拒绝终端 attach、按键与 herdr 排序操作。
- `HarnessClient` 负责协议认证、HTTP RPC、`/api/remote.mux`、`session/follow`，并将事件映射到共享 transcript。
- 流式助手文字使用稳定消息 ID；文本修订发送 reset 全量快照，避免客户端按 ID 去重时丢掉更新。重连从原生 follow 快照和历史分页重建，不清空对话。
- LiveHub 向正在查看该会话的各端广播原生事件；herdr 会话仍使用现有 JSONL 增量读取。
- herdr 离线不阻止 Harness 显示。Harness 暂时离线保留本次 agentd 进程已知的会话列表，并标成未知状态；后端恢复后重连同步。第一次连接失败时不伪造历史列表。

## 第一版限制

- 支持文本会话、历史中的文本及工具结果、实时助手文字、停止生成、重命名、项目归属和 projdeck 本地归档。
- 尚未接入附件上传、图片/视频展示、原版的权限确认、子代理专用界面、模型选择 UI。附件入口对 Harness 隐藏，后端也明确拒绝，不会静默丢弃文件。
- 需要确认时回原版 Harness 界面处理，不会自动同意操作。
- 列表状态使用 Harness 的真实运行/可用状态；不是根据终端屏幕推测。没有完整接入原版所有状态投影与完成通知语义。
- 原版 Harness 的高级功能不因本次接入失效。协议按本机 `0.2.1-rc.2` 实现，升级 Harness 后需要回归验证。

## 验证

- 本地假 HTTP/WS Host 覆盖鉴权、Cookie、RPC、超时、拒绝凭据外流、历史分页、修订、partial assistant、断线补历史与关闭。
- 服务层集成测试在 herdr 离线时验证 Harness 创建、消息、历史、停止、归档/恢复，不调用 PTY。
- LiveHub 测试覆盖多客户端共享订阅、重新配置后订阅重建、取消后的资源释放。
- 另用独立 DSH_HOME 启动真实 Harness，与隔离 agentd 完成认证、创建、列表、历史与重命名，并在浏览器打开 Harness 设置和聊天页，确认不建立 `/ws/term`。没有读取真实用户凭据，也没有调用模型。
