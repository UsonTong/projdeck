# 远程 adb（手机在身边，adb 在公司电脑上）

目标：公司电脑上执行 `adb connect 127.0.0.1:15555`，连上的就是身边的手机。无 root，手机只需要装 projdeck App。

```
电脑上的 adb ─▶ projdeck 本机端口 127.0.0.1:15555 ─(现有公网通道，/ws/adb)─▶ 手机 projdeck App ─▶ 手机 localhost:5555 (adbd TCP 模式)
```

## 系统限制（读 AOSP 源码 + 实测）

- 无线调试只在连着 Wi-Fi 时存在：Wi-Fi 断开或换网络，系统自己把 `adb_wifi_enabled` 改回 0（AdbDebuggingManager）。
- 每个 Wi-Fi 网络第一次开无线调试，系统弹「允许在这个网络上使用无线调试？」，勾选「始终允许」后，以后在这个网络上开启不再询问。
- 所以：手机重启后要连上一次已被允许的 Wi-Fi，才能自动恢复；之后切到 TCP 模式（`tcpip 5555`），关掉 Wi-Fi 用流量也能继续用，直到下次重启。
- TCP 模式监听 `*:5555`（所有网卡）。新电脑的密钥第一次连接，手机会弹「允许 USB 调试」。要提供「用完关闭 TCP 模式」的开关。
- 开发者选项里打开「禁用 adb 授权超时」，否则授权 7 天不用会失效。

## 已验证（Redmi K20 Pro，安卓 11，2026-11-01）

1. `adb tcpip 5555` 后 adbd 监听 `*:5555`；关掉手机 Wi-Fi（只剩 4G）后仍在监听。
2. 电脑 adb 经 TCP 流（`adb forward` 到手机 5555，等价于转发通道）连上，`shell` 身份，命令正常。
3. App 声明 `WRITE_SECURE_SETTINGS` 后，`adb shell pm grant dev.projdeck.app android.permission.WRITE_SECURE_SETTINGS` 成功，该机型没有拦。
4. 打开 `adb_wifi_enabled`：Wi-Fi 未被信任时系统改回 0 并弹框；点「始终允许」后开启成功，adbd 注册 mDNS `_adb-tls-connect._tcp`，端口每次不同（39787、39227……）。
5. 开机恢复路径：Wi-Fi 断开 → 系统关掉无线调试 → 重新连上已信任的 Wi-Fi → 再打开，不弹框，直接保持开启。

## App 内配对和连接（Redmi K20 Pro / MIUI，安卓 11，2026-11-01 跑通）

配对、自我授权、切到 TCP 模式全部在手机上由 App 完成，没有用电脑。踩到的坑：

- **配对码输不进去**：系统的「配对码配对」窗口一离开前台，配对服务就停止，所以不能回 App 里输入。
  - 通知里的回复框：MIUI 不显示（连聊天样式的通知也不显示）。
  - 悬浮窗：设置界面的窗口带着 `HIDE_NON_SYSTEM_OVERLAY_WINDOWS`，系统会把所有第三方悬浮窗藏起来（安卓故意的）。
  - 最后用 **无障碍服务**（`PairingAccessibilityService`）：只限「设置」(`com.android.settings`) 一个包，配对时读出窗口里的配对码和端口，自动配对，用完 `disableSelf()`。
- **mDNS 在 MIUI 上发现不了端口**（`connectTls` 超时，日志里一堆 `SERVICE_RESOLVED has no client mapping`）。备用办法：扫描本机 32768～60999 的监听端口，逐个用 libadb 的 `connect("127.0.0.1", port)` 试，连上的就是无线调试的 TLS 端口。扫描大约 12～17 秒。
- 配对成功后，App 通过 TLS 连接发 `shell:pm grant <包名> android.permission.WRITE_SECURE_SETTINGS` 自己授权，再发 `tcpip:5555` 切到 TCP 模式。

## 还没验证

- realme RMX3706（安卓 16，ColorOS）：授权、后台存活、自启动、各项限制。
- 转发通道：`/ws/adb` 多路复用、断线重连、延迟。
- 端口扫描太慢：记住上次成功的端口，先试它。
- realme（安卓 16）上，无障碍服务属于「受限制的设置」，侧载安装的 App 要先在应用信息里「允许受限制的设置」才能打开。

## 实现顺序

1. ~~App 内 adb 客户端 + 配对界面；自己给自己授权。~~（已完成，libadb-android：GPL-3.0-or-later 或 Apache-2.0 双协议，Apache 版带一个 LGPL 依赖）
2. 常驻服务：开机等 Wi-Fi → 打开无线调试 → mDNS 找端口 → 连接 → `tcpip` → 关无线调试。
3. 转发通道：agentd 监听 127.0.0.1:15555，经 `/ws/adb` 转给 App，App 转到 localhost:5555。
4. App 和网页设置里的开关与状态；realme 设置指南（自启动、电池、权限监控）。
