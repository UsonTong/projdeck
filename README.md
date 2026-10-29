# projdeck

以项目为中心的 AI 编程 agent 控制台，建立在 [herdr](https://herdr.dev) 之上。

- 电脑前照常用 herdr；离开电脑后，用手机 / 平板 / 其他电脑的浏览器操控**同一批**会话。
- 按项目分组显示 Claude Code / Codex / 临时终端，实时状态。
- 在网页里粘贴、拍照、选图发给 agent（解决 SSH 无法粘贴图片的问题）。
- 交互式网页终端（Ghostty 渲染），与电脑上的 herdr 是同一个终端；手机上有键盘辅助栏（Esc / Tab / Ctrl / 方向键）。
- 对话气泡视图：把 Claude / Codex 的会话记录渲染成聊天界面。
- 在项目里启动 agent 时自动通过「信任此文件夹」确认。
- 隐藏不想看到的会话；归档做完的会话（关闭 pane，保留对话，可一键 resume）。

设计说明见 [docs/DESIGN.md](docs/DESIGN.md)。

## 本机运行

需要 Node 22.18+（直接运行 TypeScript）、pnpm、正在运行的 herdr，以及编译 node-pty 所需的 C++ 工具链（make、g++、python3）。

```sh
pnpm install
pnpm build                                    # 构建前端到 packages/web/dist
pnpm --filter @projdeck/agentd cli set-password   # 设置登录密码（至少 12 位）
pnpm start                                    # 启动 agentd，默认 http://127.0.0.1:7420
```

浏览器打开 <http://127.0.0.1:7420>，登录后点「＋ 项目」新建或导入项目。

在同一 Wi-Fi 下用手机试用：`PROJDECK_HOST=0.0.0.0 pnpm start`，然后访问 `http://<电脑IP>:7420`。

### 长期运行

```sh
cp deploy/projdeck-agentd.service deploy/herdr-server.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable herdr-server              # herdr 服务端开机自启（先改好文件里的图形环境变量）
systemctl --user enable --now projdeck-agentd
loginctl enable-linger $USER
```

电脑重启后 herdr 服务端随开机启动，不用先打开终端；桌面上照常运行 `herdr` 会连到这个服务端。
herdr 被关掉时，网页顶部会提示「herdr 未运行」，点「启动 herdr」即可。

## 部署到服务器（外网访问）

agent 和代码都留在本机，服务器只做 HTTPS 和转发，**不需要部署任何代码**。

```
公网 https://<IP>:18420 ── nginx（projdeck-edge 容器，TLS + 访问 key）
        ──► 服务器 127.0.0.1:17420 ── SSH 反向隧道 ──► 本机 agentd 127.0.0.1:7420
```

1. **隧道**（本机）：`deploy/projdeck-tunnel.service` 改好服务器地址后放进 `~/.config/systemd/user/` 并启用。
2. **入口**（服务器）：`deploy/projdeck-edge.conf` 里的 `__KEY__` 换成访问 key
   （本机 `~/.config/projdeck/edge-key`），放到 `/root/projdeck-edge/conf.d/`，用 `nginx:1.25-alpine`
   以 host 网络运行，挂载证书目录。可使用 Let's Encrypt 的 IP 证书（`preferred_profile = shortlived`），
   证书续期后需要 `nginx -s reload`。
3. **安全组**：放行 TCP 18420。
4. **使用**：每个浏览器第一次打开 `https://<IP>:18420/k/<访问 key>`，之后直接打开 `https://<IP>:18420`，
   再用 projdeck 密码登录。没有 key 的请求一律 404。

暂时没有 IP 证书或域名时，也可以用 `deploy/Caddyfile` 先走 HTTP（密码明文传输，只适合短期使用）。

## 常见问题

**网页终端打开后提示符重复、错位（Powerlevel10k）**：网页 attach / 断开时 pane 宽度会变，herdr 重排文字后，
zsh 按旧的行数重画提示符就会错位。p10k 第一行右侧有内容（✔、耗时等）时第一行撑满整行，最容易触发。
在 `~/.zshrc` 里 `source ~/.p10k.zsh` 之后加上，只在 herdr pane 里把右侧信息放到输入行：

```zsh
if [[ $HERDR_ENV == 1 ]]; then
  typeset -g POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=(newline ${POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS:#newline})
fi
```

原理见 p10k README 的「Horrific mess when resizing terminal window」。

## 开发

```sh
pnpm --filter @projdeck/agentd dev            # agentd，改代码自动重启
pnpm --filter @projdeck/web dev               # 前端热更新，/api 与 /ws 代理到 7420
pnpm typecheck && pnpm test
```

开发时不想碰正在使用的 herdr，可以起一个独立的 herdr 会话：

```sh
herdr --session projdeck-test server &
PROJDECK_HERDR_SOCKET=~/.config/herdr/sessions/projdeck-test/herdr.sock \
PROJDECK_CONFIG_DIR=/tmp/projdeck-dev PROJDECK_PORT=7421 \
  pnpm --filter @projdeck/agentd dev
PROJDECK_AGENTD=http://127.0.0.1:7421 pnpm --filter @projdeck/web dev
```

## 配置

`~/.config/projdeck/`：

| 文件 | 内容 |
|---|---|
| `config.json` | 端口、项目根目录（默认 `~/Projects`）、herdr socket、密码哈希 |
| `projects.json` | 登记的项目，含每个项目启动 agent 的参数（默认 `--dangerously-skip-permissions` / `--yolo`） |
| `archive.json` | 归档的会话 |
| `state.json` | 隐藏规则、会话归属记忆、Codex 对话手动指定 |
| `sessions.json` | 已登录设备（只存 token 哈希） |

环境变量 `PROJDECK_CONFIG_DIR`、`PROJDECK_HERDR_SOCKET`、`PROJDECK_HOST`、`PROJDECK_PORT` 优先于配置文件。
