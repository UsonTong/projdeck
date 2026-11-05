# Agent 主动展示资源

Agent（Claude / Codex / DeepSeek 等）在终端里运行：

```sh
projdeck present /绝对路径/图片.png --title "可选的标题"
```

网页和手机 App 会立即弹出这张图片；网页是正式对话框，手机是 Flutter 对话框，支持缩放和关闭。

## 规则

- 目前支持 png / jpg / gif / webp / avif，单张不超过 50MB。
- 只允许项目目录、projdeck 上传目录和系统临时目录（`/tmp`）里的文件，避免把任意系统文件暴露给浏览器。
- 命令只连本机 agentd（127.0.0.1），用 `~/.config/projdeck/edge-key` 认证；不会把密钥打印出来。
- 图片地址是 `/api/present/<id>`，仍需要 projdeck 登录 Cookie；浏览器和手机都只拿同源链接。
- 资源只保留最近 50 个，存在内存里，重启 agentd 后清空；原始图片不复制、不删除。
- `projdeck` 命令已链接到本仓库的 `packages/agentd/src/cli.ts`；仓库移动后需要重新建链接。

## 给 Agent 的提示

在项目里生成截图或导出图表后，直接执行：

```sh
projdeck present ./截图.png --title "登录页对比"
```

如果用户说想看某张图片，先确认路径在该项目、上传目录或 `/tmp` 内，再执行上面的命令。不要用 base64 塞进消息里。
