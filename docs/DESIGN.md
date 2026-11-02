# projdeck 设计文档

> project + deck：以项目为中心的 AI 编程 agent 控制台，建立在 herdr 之上。
> 电脑前照常用 herdr；离开电脑用 projdeck 网页继续操控同一批会话。

---

## 1. 问题与目标

| 痛点 | projdeck 的解法 |
|---|---|
| 离开电脑无法操控本地运行的 Claude Code / Codex | 网页（手机 / 平板 / 其他电脑）远程查看与操控 |
| SSH 远程时无法粘贴图片 | 网页上传图片 → 存入项目目录 → 把路径发给 agent |
| herdr 是平铺的 workspace 列表，缺少项目维度 | 按项目分组，支持隐藏 / 归档 |
| 喜欢现有 herdr + claude 工作流 | **不替代 herdr**，herdr 是唯一的会话真相源 |

### 非目标（明确不做）

- 不自己启动和托管 agent 进程，一切经由 herdr。
- 不做通用远程终端（那是 Moshi 的定位）。projdeck 的一等公民是**项目**。
- 不做多用户。

---

## 2. 核心原则

1. **herdr 是唯一真相源**。projdeck 不保存任何 agent 的运行时状态，只做查询和转发。
   herdr TUI 和 projdeck 网页是同一个 herdr server 的两个"屏幕 + 遥控器"。
2. **项目归属靠推导，不靠同步**。projdeck 只保存"项目文件夹列表"，
   agent 属于哪个项目，由 pane 的 `cwd` 在每次查询时现场计算。
   在 herdr 里做的任何操作都会自动反映到 projdeck，不存在不同步问题。
3. **作业在本地，入口在服务器**。服务器只做认证和转发，代码、会话、图片都留在本地。
4. **herdr 适配层隔离**。所有 herdr 调用集中在一个模块里，herdr 升级时只改这一处。

### 唯一的使用约定

> **要被项目管理的 agent，就在项目文件夹里启动。**
> 在 `~` 等位置随手开的会话归入「未归属」，不影响使用。

---

## 3. 系统架构

```
 手机 / 平板 / 其他电脑（浏览器，PWA）
                │  HTTP + WebSocket
┌───────────────▼──────────────── 服务器 ────────────────┐
│ Caddy（以后配域名后启用 HTTPS）                           │
│   └─ 整站反代     → 127.0.0.1:<隧道端口>                 │
└───────────────┬────────────────────────────────────────┘
                │  SSH 反向隧道（autossh -R，复用现有隧道）
┌───────────────▼──────────────── 本地电脑 ──────────────┐
│ projdeck-agentd（Node，仅监听 127.0.0.1:7420）           │
│   ├─ Web             前端静态文件（服务器无需部署代码）     │
│   ├─ Auth            认证与会话                          │
│   ├─ HerdrClient     herdr socket 适配层                 │
│   ├─ ProjectService  项目登记 / 归属推导 / 隐藏 / 归档     │
│   ├─ Transcript      Claude / Codex 会话记录解析          │
│   ├─ Uploads         图片写入 项目/.uploads/              │
│   └─ Live            WebSocket 推送（状态、输出）          │
│                                                          │
│ herdr server ←── 你在电脑前使用的 herdr TUI                │
│   └─ claude / codex / shell panes                        │
└──────────────────────────────────────────────────────────┘
```

### 为什么认证放在 agentd 而不是服务器？

- 认证逻辑和数据都在本地，服务器只是一层"哑"代理，服务器被入侵也拿不到登录凭据。
- 开发时在本地局域网直接访问 agentd，和线上行为一致。
- Caddy 额外做一层限流和 IP 级防护。

---

## 4. 概念模型

```
项目（Project）           ← projdeck 维护：文件夹路径 + 元信息
 └─ 会话（Session）       ← 从 herdr 推导：一个 pane = 一个会话
     ├─ kind: claude | codex | shell
     ├─ status: working | idle | blocked | done | unknown
     └─ conversationId    ← Claude 由 herdr 提供；Codex 按目录与时间匹配
```

| projdeck | herdr | 说明 |
|---|---|---|
| 项目 | （无直接对应） | 一个文件夹；通常对应一个 workspace，但不强制 |
| 会话 | pane | 一个 agent 或一个临时终端 |
| agent | 检测到 claude / codex / pi 的 pane | `agent.list` 返回 |
| 临时终端 | 未检测到 agent 的 pane | 在项目目录里查东西、跑命令 |

### 4.1 归属推导规则

实测发现 herdr 的 pane `cwd` 与 `foreground_cwd` **都会跟随 shell 的 `cd` 变化**，没有"启动目录"字段。
因此按以下顺序判断（实现见 `agentd/src/projects/attribution.ts`）：

1. **记忆**：此前已归属过的 terminal 保持原项目（`state.json` 中的 sticky，terminal 消失后清理）。
2. **最长前缀匹配**：当前 cwd 落在哪个项目文件夹下（嵌套时 `~/Projects/a/b` 优先于 `~/Projects/a`）。
3. **同 workspace 兜底**：同一 workspace 中其他 pane 只属于一个项目时，归入该项目。
   临时终端 `cd` 出项目目录后仍留在项目里。
4. 都不满足 → 「未归属」。

被隐藏的会话 / 项目不出现在主列表中（见第 6 节）。

### 4.2 项目来源

- **新建**：在 `~/Projects/<名称>` 创建文件夹，可选 `git init`，同时创建同名 herdr workspace。
- **导入**：登记已有文件夹（如 `~/Repositories/wx-monitor`），文件夹原地不动。
- 首次启动时扫描当前 herdr 中所有 pane 的 cwd，**建议**导入（由你确认，不自动导入）。

---

## 5. 数据存储

全部放在本地 `~/.config/projdeck/`，纯 JSON 文件，方便手动编辑和备份：

```
~/.config/projdeck/
├── config.json      # 端口、项目根目录、认证配置
├── projects.json    # 项目登记
├── archive.json     # 归档的会话
└── hidden.json      # 隐藏规则
```

```ts
// projects.json
interface Project {
  id: string;            // slug，如 "wx-monitor"
  name: string;          // 显示名
  path: string;          // 绝对路径，唯一
  createdAt: string;
  archived: boolean;     // 整个项目归档
  defaultAgent: "claude" | "codex" | "pi";
  agentArgs?: Record<"claude" | "codex" | "pi", string[]>; // 如 ["--dangerously-skip-permissions"] / ["--yolo"] / []
}

// archive.json
interface ArchivedSession {
  id: string;
  projectId: string;
  kind: "claude" | "codex";
  conversationId: string;  // Claude session id / Codex session id
  title: string;           // 归档时的终端标题，如「交接文档与当前进度」
  cwd: string;
  archivedAt: string;
}

// hidden.json
interface HiddenRule {
  // pane id 是运行时 ID，herdr 重启会变；因此按对话 ID 隐藏，退化到按 pane id
  conversationId?: string;
  paneId?: string;
  hideUnassigned?: boolean;  // 整个「未归属」分组折叠
}
```

---

## 6. 隐藏与归档

herdr 本身没有隐藏 / 归档的概念（已确认），因此由 projdeck 实现。

| | 隐藏 | 归档 |
|---|---|---|
| herdr 中的 pane | 保留，继续运行 | **关闭** |
| herdr TUI 中可见 | 是 | 否 |
| projdeck 主列表 | 不显示 | 不显示 |
| 去向 | 「已隐藏」筛选 | 「已归档」列表 |
| 恢复 | 取消隐藏 | 在项目目录新开 pane，`claude --resume <id>` / `codex resume <id>` |
| 适用场景 | 在 `~` 随手开、不想在手机上看到的会话 | 做完的任务，想收起来但保留对话 |

### 归档流程

1. 若会话状态为 `working`，前端二次确认。
2. 解析 `conversationId`（Claude 直接取；Codex 见 8.2，匹配不确定时让用户选择）。
3. 写入 `archive.json`。
4. 调用 `pane.close`。
5. 若该 workspace 已无 pane，herdr 会自行关闭 workspace。

### 恢复流程

1. 在项目对应的 workspace 中 `tab.create`（若无 workspace 则 `workspace.create`，cwd = 项目路径）。
2. 在新 pane 中运行恢复命令（带上项目配置的 `agentArgs`，比如 yolo 参数）。
3. 从 `archive.json` 删除。

> 恢复的是**对话上下文**，不是进程。原终端中运行的后台任务（dev server 等）不会恢复。

### 项目归档

项目标记为 `archived`，从项目列表收起。可选择一并归档其下所有会话。

---

## 7. agentd API

所有接口需要认证（Cookie 会话）。前缀 `/api`。

### 7.1 REST

```
POST   /api/auth/login                  { password, totp? } → Set-Cookie
POST   /api/auth/logout

GET    /api/overview                    项目 + 会话 + 状态（总览页一次拉取）
GET    /api/projects
POST   /api/projects                    { name } 新建 | { path } 导入
PATCH  /api/projects/:id                改名 / 默认 agent / 归档
DELETE /api/projects/:id                仅取消登记，不删文件
GET    /api/projects/suggestions        从 herdr 现有 pane 推测可导入的文件夹

POST   /api/projects/:id/sessions       { kind: "claude" | "codex" | "shell" } 启动会话
GET    /api/sessions/:paneId/output     ?lines=N&format=ansi 终端输出快照
GET    /api/sessions/:paneId/transcript ?after=<cursor> 结构化对话（聊天气泡）
POST   /api/sessions/:paneId/prompt     { text, images?: string[] } 发消息
POST   /api/sessions/:paneId/keys       { keys: ["Escape"] } 发按键
POST   /api/sessions/:paneId/hide
POST   /api/sessions/:paneId/archive

GET    /api/archive                     ?projectId=
POST   /api/archive/:id/restore
DELETE /api/archive/:id

POST   /api/projects/:id/uploads        multipart 图片 → { path }
GET    /api/projects/:id/uploads/:file  缩略图预览
```

### 7.2 WebSocket `/ws`

客户端订阅，服务端推送：

```ts
// 客户端 → 服务端
{ op: "watch", paneId: string }     // 进入某会话详情页
{ op: "unwatch", paneId: string }

// 服务端 → 客户端
{ type: "overview", overview }                       // 总览有变化时推送完整总览（体积很小）
{ type: "output", paneId, text }                     // 仅推送给 watch 中的会话，最近 300 行 ANSI
{ type: "transcript", paneId, page }                 // 会话记录增量；page.reset 时为全量
```

**推送策略**：

- 总览：herdr 事件触发刷新（250ms 防抖）+ 每 2s 轮询兜底。`pane.agent_status_changed` 只能按 pane 订阅，
  没有全局事件，所以状态变化靠轮询发现。内容没变不推送。
- 输出：herdr 没有输出流事件，只对被 watch 的 pane 轮询 `pane.read`（`working` 时 1s，其余 3s），变化才推送。
  WebSocket 开启 permessage-deflate，终端文本压缩率很高。没人看时不轮询。
- 会话记录：被 watch 时每 1.5s 按字节游标增量读取。

---

## 8. 关键模块设计

### 8.1 HerdrClient（适配层）

- 连接 `~/.config/herdr/herdr.sock`，协议为**换行分隔 JSON**（已验证）：
  `{"id","method","params"}` → `{"id","result"}` / `{"id","error"}`。
- 一条长连接用于请求，一条独立连接用于 `events.subscribe`，断线指数退避重连。
- 启动时校验协议版本（当前为 22），不一致时在网页顶部提示，但不阻止使用。
- 类型从 `herdr api schema --json` 生成（`json-schema-to-typescript`），作为开发期脚本。
- 用到的 herdr 方法：

| 用途 | 方法 |
|---|---|
| 总览 | `workspace.list` `pane.list` `agent.list` |
| 状态推送 | `events.subscribe`：`pane.created/closed/exited/agent_status_changed/agent_detected`、`workspace.created/closed/renamed` |
| 读输出 | `pane.read`（`source: recent`，`format: ansi`） |
| 发消息 | `agent.prompt`；shell 用 `pane.send_input` |
| 发按键 | `pane.send_keys` |
| 启动 | `workspace.create` / `tab.create`（cwd = 项目路径），`agent.start` 或 `pane.run` |
| 归档 | `pane.close` |
| 标签 | `workspace.report_metadata`（在 herdr 侧边栏显示项目名；TTL 最长 24h，agentd 定时续期） |

### 8.2 会话记录（聊天气泡）

**Claude**（可靠）

- `agent.list` → `agent_session.value` 即 session id。
- 文件：`~/.claude/projects/<cwd 中的 / 替换为 ->/<id>.jsonl`。
- 增量读取：记录字节偏移作为 cursor，按行解析。
- 渲染：`user` / `assistant` 文本、工具调用折叠为一行摘要（如「编辑 src/app.ts」）、图片缩略图。
  跳过 `mode`、`permission-mode`、`file-history-snapshot` 等内部记录。

**Codex**（启发式）

- herdr 不提供 Codex 的 session id，codex 进程也不常驻打开 rollout 文件（已验证）。
- 匹配：扫描 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 首行 `session_meta`，
  取 `payload.cwd == pane cwd` 且最近修改的文件。
- 同一目录同时有多个 Codex 时可能认错 → 界面提供「选择对话」兜底，选择结果按 pane 记住。

**两种视图**：会话详情页可在「气泡」与「终端」之间切换。终端视图永远可用，是兜底。

### 8.3 发图

1. 前端：粘贴 / 拍照 / 相册 → 客户端压缩（长边 ≤ 2560px，保留 PNG 截图清晰度）。
2. 上传到 `/api/projects/:id/uploads` → 写入 `项目/.uploads/20261028-153012-ab12.png`。
3. 首次写入时把 `.uploads/` 追加到项目的 `.git/info/exclude`（不修改 `.gitignore`）。
4. 返回绝对路径，前端以附件 chip 显示在输入框上方。
5. 发送时把路径拼在消息末尾：`<文本>\n\n<路径1> <路径2>`。
   Claude Code 与 Codex 都会把输入中的图片路径识别为图片附件。
6. `.uploads/` 中超过 30 天的文件定期清理（可配置）。

### 8.4 认证

- 单用户密码（scrypt 哈希存于 `config.json`，用 Node 内置 crypto，避免原生依赖）。TOTP 暂未实现。
- 登录成功后发放 HttpOnly + SameSite=Strict Cookie，有效期 30 天，可在设置页吊销所有会话。
- 登录失败限流：同 IP 5 次 / 15 分钟。
- WebSocket 握手校验同一 Cookie 和 Origin。
- 没有域名期间走 HTTP，**密码在传输中是明文**，因此开发期间仅限短期使用；上线必须配域名 + HTTPS。

### 8.5 网页终端

会话页默认是交互式终端，与电脑上的 herdr 是同一个终端：

```
ghostty-web（Ghostty 的 VT 引擎，WASM，canvas 渲染）
   ⇅ WebSocket /ws/term?pane=…   二进制帧 = 终端原始输出；文本帧 = JSON（输入 / 改尺寸 / 错误）
agentd：node-pty 中运行 `herdr terminal attach <terminal_id>`（agentd/src/terminal.ts）
   ⇅
herdr server
```

实测结论（herdr 0.9.5）：

- `terminal attach` 对 agent pane 和普通 shell pane 都可用。`agent attach` 只接受 agent；给 shell 声明 agent 的办法有竞态
  （herdr 300–400ms 内就会清除声明），已弃用。
- **不加 `--takeover`**：多个 attach 客户端与电脑上的 herdr TUI 可同时连接；加了会踢掉其他 attach 客户端。
- attach 期间 pane 尺寸跟随网页终端；网页断开后 herdr 自动恢复为 TUI 的尺寸。网页切到后台 15 秒即断开，避免电脑上的 pane 一直被缩小。
- attach 客户端把 Ctrl+B 当前缀键（`Ctrl+B q` 断开）。agentd 把网页发来的每个 Ctrl+B 转义为 Ctrl+B Ctrl+B，herdr 还原为一个字面 Ctrl+B。
- `pane.send_input` 是字面粘贴（`\r`、转义序列都不生效），所以原生交互只能走 attach。

输入处理：

- ghostty-web 只从 keydown 与输入法 compositionend 取字，并拦截所有 beforeinput。Android 软键盘（keyCode 229）、语音输入、
  滑行输入只通过 beforeinput 送达文字，projdeck 在外层捕获阶段补处理 `insertText` / `insertLineBreak` / `deleteContentBackward`。
  ghostty-web 处理过的按键会阻止 keydown 默认行为，浏览器不再触发 beforeinput，因此不会重复输入。
- 手机键盘辅助栏：Esc、Tab、⇧Tab、粘滞 Ctrl、方向键（遵循 DECCKM）、^C 等，以原始字节发送；按钮用 pointerdown + preventDefault，点按不收起软键盘。
- 粘贴 / 拖入 / 选择图片：上传到 `项目/.uploads/`，把路径粘贴进终端，Claude 识别为 `[Image #n]`。
- 长文本或想用输入框时，辅助栏的键盘按钮展开输入框（走 `agent.prompt`）。

字体：Nerd Font 图标（Powerline 提示符等）使用 Nerd Fonts v3.5.1 官方 Symbols Only（MIT，WOFF2 1.2MB），
`unicode-range` 限定在图标区；渲染前等待字体加载完成，因为 canvas 不会因字体晚到而重绘。终端引擎按需加载，不拖慢总览页。

### 8.6 自动通过信任确认

projdeck 启动 agent（新建会话、归档恢复）后，观察 pane 最多 20 秒：看到「信任此文件夹」菜单就把光标移到 Yes 并确认，
看到可输入状态即停止。只对 projdeck 登记的项目目录生效（用户主动新建或导入，本身就代表信任）。
菜单解析是纯函数（`agentd/src/trust.ts`），不假设选项顺序，用真实屏幕做单元测试。

---

## 9. 前端设计

React + Vite，移动端优先，PWA（可添加到主屏幕）。界面基于 [shadcn/ui](https://ui.shadcn.com)（Radix 底层、Nova 预设、Tailwind CSS v4），只用暗色主题；组件源码在 `packages/web/src/components/ui/`，可直接修改。

### 9.1 总览页

```
┌─────────────────────────────┐
│ projdeck            ⚙  ＋项目 │
├─────────────────────────────┤
│ ▼ wx-monitor           ● 1  │  ● 工作中  ○ 空闲  ◆ 需处理
│    ● codex  查看交接文档      │
│    ○ shell  临时终端          │
│ ▼ taskforge                 │
│    ○ claude 问题修复策略      │
│ ▶ huiyinwanjia         ○    │  （折叠）
│ ─────────────────────────── │
│ ▶ 未归属 (5)                 │
│ ▶ 已归档                     │
└─────────────────────────────┘
```

- 有 `working` / `blocked` 会话的项目排在前面。
- 左滑会话：隐藏 / 归档。
- 项目右侧「＋」：新开 claude / codex / 临时终端。

### 9.2 会话页

```
┌─────────────────────────────┐
│ ← 标题 · 项目 · Claude ● [终端|对话] ⋯ │
├─────────────────────────────┤
│                             │
│  终端：Ghostty 渲染的真实终端，  │
│  直接点按输入（默认）           │
│  对话：会话记录渲染的聊天气泡     │
│                             │
├─────────────────────────────┤
│ ctrl esc tab ⇧tab ↑ ↓ ← → ^C │ 🖼 ⌨ │  键盘辅助栏（手机）；电脑上只有 🖼 ⌨
├─────────────────────────────┤
│ （⌨ 展开）输入框 + 图片附件     │  对话视图下常驻
└─────────────────────────────┘
```

- 视图与字号（⋯ 菜单 A−/A+）记在本机。临时终端只有终端视图。
- 对话视图下会话「需处理」时，底部提示切到终端操作。

### 9.3 平板 / 电脑

同一套页面，宽屏时左栏是总览、右栏是会话页，与 herdr 的布局习惯一致。

---

## 10. 技术栈与目录

```
projdeck/
├── package.json             # pnpm workspace
├── packages/
│   ├── shared/              # 前后端共享类型、API 契约
│   ├── agentd/              # Node 22 + Fastify + ws
│   │   └── src/
│   │       ├── herdr/       # HerdrClient、生成的协议类型
│   │       ├── projects/    # 登记、归属推导、隐藏、归档
│   │       ├── transcript/  # claude.ts、codex.ts
│   │       ├── uploads/
│   │       ├── auth/
│   │       └── live/        # WebSocket、输出轮询
│   └── web/                 # React + Vite + shadcn/ui + Tailwind，PWA
├── deploy/
│   ├── Caddyfile
│   ├── projdeck-agentd.service   # systemd --user
│   └── projdeck-tunnel.service   # autossh 反向隧道
└── docs/DESIGN.md
```

- 测试：Vitest。HerdrClient 用录制的 socket 响应做单元测试；归属推导、会话记录解析是纯函数，重点测试。
- 本地运行：`systemd --user` 托管 agentd，开机自启（herdr server 未运行时 agentd 照常启动，等待重连）。

---

## 11. 部署

1. **本地**：`projdeck-agentd.service` 监听 `127.0.0.1:7420`，同时提供前端页面。
2. **隧道**：在现有反向隧道里加 `-R 127.0.0.1:7420:127.0.0.1:7420`（只绑定服务器回环地址，不直接暴露），
   或使用 `deploy/projdeck-tunnel.service`。
3. **服务器**：Caddy 整站反代到 `127.0.0.1:7420`（`deploy/Caddyfile`），服务器上不部署任何代码。
   - 暂无域名：`http://<IP>:8080`。
   - 有域名后：Caddy 自动申请证书，无需改代码。

---

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| herdr 升级导致 API 变化 | 适配层隔离；启动时校验协议版本；固定 herdr 版本后再升级 |
| Codex 会话匹配错误 | 只用于气泡视图和归档；提供手动选择；终端视图始终可用 |
| herdr server 未运行 | 网页显示「herdr 离线」，项目和归档仍可浏览；提供「启动 herdr server」按钮 |
| 隧道断开 | autossh 自动重连；网页显示「本地离线」 |
| 远程入口被滥用（agent 均为 yolo 模式） | 强密码 + 限流 + 可选 TOTP；尽快上 HTTPS；agentd 只听回环地址 |
| 手机与电脑同时输入 | 不做锁；herdr 本身允许多端输入，实际使用中不会同时操作 |

---

## 13. 里程碑

| # | 内容 | 验收 |
|---|---|---|
| — | **M1–M5 已完成（2026-10-28）**，M6 的部署文件已写好，待在服务器上实际配置 | — |
| M1 | agentd 骨架 + HerdrClient + 项目登记 + 归属推导 + `/api/overview` | 本地 curl 能看到按项目分组的会话与状态 |
| M2 | web：登录、总览、会话页（终端文本视图 + 输入 + 快捷键） | 手机在局域网内能操控 herdr 里的 claude |
| M3 | 发图 | 手机拍照发给 claude，claude 能看到图片 |
| M4 | 聊天气泡（Claude → Codex） | 气泡视图与终端视图可切换 |
| M5 | 隐藏 / 归档 / 恢复，新建 / 导入项目，临时终端 | 归档后 herdr 中 pane 关闭，恢复后对话接上 |
| M6 | 部署：Caddy + 反向隧道 + systemd | 外网手机可用 |
| — | **网页终端（ghostty-web + terminal attach）、自动信任已完成** | 手机上直接操作 Claude / Codex / 临时终端 |
| 后续 | 完成通知、域名 + HTTPS、TOTP、worktree | — |

### 待验证（实现对应里程碑时确认）

- [x] herdr socket 帧格式：换行分隔 JSON
- [x] 事件订阅类型：有 `pane.agent_status_changed` 等，无输出流事件 → 轮询
- [x] Claude session id 来源与 jsonl 路径
- [x] Codex 恢复命令：`codex resume <SESSION_ID>`
- [x] `agent.prompt` 对多行文本的处理：整段作为一条消息提交
- [x] Claude 对路径形式图片的识别：转为 `[Image #1]` 附件，jsonl 中有 `[Image: source: <路径>]` 记录
- [ ] Codex 对路径形式图片的识别（尚未实测）
- [x] Codex rollout 匹配：真实环境中按 cwd + 修改时间匹配正确；同目录多个 Codex 时提供手动选择
- [x] pane 的 cwd 会跟随 cd 变化 → 归属规则增加记忆与同 workspace 兜底（见 4.1）
- [x] attach 对电脑端 TUI 的影响：不加 --takeover 可共存，断开后尺寸恢复（见 8.5）


## Pi（pi coding agent）

- herdr 原生支持（`agent.start --kind pi`；pi 里装了 `herdr-agent-state.ts` 扩展上报状态），`agent.list` 里 `agent: "pi"`。
- 会话文件：`~/.pi/agent/sessions/--<cwd 去掉开头分隔符、/ \ : 换成 ->--/<时间>_<会话id>.jsonl`（格式见 pi 自带的 `docs/session-format.md`）。
  herdr 的 `agent_session` 对 pi 是**文件路径**（`kind: "path"`，会话一开始就有，但文件要到第一条消息之后才出现），projdeck 从路径里取会话 id 作为 conversationId。
- 对话气泡：`agentd/src/transcript/pi.ts` 解析 `message` 记录里的 `user`（文本）、`assistant`（文本、`toolCall` → 工具行），系统消息 / 思考 / `toolResult` 不显示。
- 恢复归档的会话：`pi --session <会话id>`。pi 没有 `--yolo`：它的工具本来就不逐个确认，相当于一直是 yolo；唯一的确认是「信任项目里的本地文件」（AGENTS.md、`.pi/` 里的扩展），默认参数用 `--approve` 直接信任，所以也没有「信任此文件夹」菜单要自动处理。
