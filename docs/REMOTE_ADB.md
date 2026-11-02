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

## 转发通道（已跑通，2026-11-02）

- 服务器：`packages/agentd/src/adbRelay.ts`。手机 App 连上 `/ws/adb`（需要登录）时，agentd 才在本机 `127.0.0.1:15555` 监听；电脑上 `adb connect 127.0.0.1:15555` 的每个连接经 WebSocket 多路复用转给手机，手机断开就停止监听。帧格式：`[类型 1 字节][连接号 4 字节大端][数据]`，OPEN=1、DATA=2、CLOSE=3，单帧数据 ≤ 32KB（websocket 插件限制 64KB）。有背压：积压超过 8MB 暂停读电脑那一端。
- 手机：`AdbRelayService`（前台服务，OkHttp WebSocket）把每个连接转给本机 `127.0.0.1:5555`；同一个服务里的 `recoveryLoop` 发现 5555 没在监听、又连着 Wi-Fi，就用 App 自己的授权打开无线调试 → 发 `tcpip:5555` → 关无线调试，失败时间隔逐步拉长到 5 分钟。开机后由 `BootReceiver` 拉起。
- 实测（Redmi K20 Pro）：`adb connect 127.0.0.1:15555` 得到 `shell` 身份；30MB 随机文件推、拉的校验值一致（推 2.2MB/s、拉 3.3MB/s，路径绕公网服务器）；4 个 shell 并行；**手机 Wi-Fi 关掉、只用移动数据时依然可用**。
- 安全：`127.0.0.1:15555` 是本机端口，公司电脑上的任何程序都能用它连手机，等同于拿到手机的 shell。手机上的「远程连接」开关关掉就停止监听；新的电脑密钥第一次连接，手机会弹「允许 USB 调试」。

## 还没验证

- realme RMX3706（安卓 16，ColorOS）：授权、后台存活、自启动、各项限制。
- 手机重启后的自动恢复（逻辑已写，没有实机重启测过）。
- 新的电脑密钥第一次连接时的授权弹框。
- 端口扫描太慢：记住上次成功的端口，先试它。
- realme（安卓 16）上，无障碍服务属于「受限制的设置」，侧载安装的 App 要先在应用信息里「允许受限制的设置」才能打开。

## 实现顺序

1. ~~App 内 adb 客户端 + 配对界面；自己给自己授权。~~（已完成，libadb-android：GPL-3.0-or-later 或 Apache-2.0 双协议，Apache 版带一个 LGPL 依赖）
2. ~~常驻服务：开机等 Wi-Fi → 打开无线调试 → 找端口 → 连接 → `tcpip` → 关无线调试。~~（已完成，未实机重启测试）
3. ~~转发通道：agentd 监听 127.0.0.1:15555，经 `/ws/adb` 转给 App，App 转到 localhost:5555。~~（已完成）
4. App 和网页设置里的开关与状态；realme 设置指南（自启动、电池、权限监控）。

## 独立转发进程（2.3.0）

**问题**：转发原先是 App 里的前台服务。小米在多任务界面「划掉」App 时（日志里是 `am_kill ... due to SwipeUpClean`）
会连前台服务一起杀掉；Termux、Shizuku、黑阈划掉后不掉线，是因为 Shizuku / 黑阈的核心**根本不是 App 组件**：
Shizuku 的启动器（`starter.cpp`）先 `fork()`、`setsid()` 脱离会话，再 `execvp("app_process", …, "rikka.shizuku.server.ShizukuService")`，
是 shell（或 root）身份下的独立进程，系统清理 App 碰不到它。

**做法**：照同样的办法。`RelayMain`（独立进程，shell 身份）里跑 `RelayCore`（WebSocket ↔ 本机 5555 的转发，和 App 内的备用转发是同一份代码）。
App 的 `AdbRelayService` 退化成看管者（`superviseLoop`）：
1. 通过本机 5555 的 adb（App 的密钥已在 `adb_keys` 里）执行
   `CLASSPATH=<base.apk> PROJDECK_BASE=… PROJDECK_KEY=… setsid nohup app_process /system/bin --nice-name=projdeck_relay dev.projdeck.app.RelayMain … &`，
   配置走环境变量（别的 App 读不到）。命令末尾要 `sleep 1`，否则 shell 退得太快，后台进程来不及脱离（实测）；
2. 独立进程起来之前，App 内的 `RelayCore` 先顶上，起来后退场（服务器上后连的顶掉先连的，没有空档）；
3. 本机 `127.0.0.1:15556` 是独立进程的状态口：`status` 返回版本/状态/错误，`quit` 让它退出。版本和 App 不一致（升级后）就让它退出再重启；
4. 用户关掉「远程连接」开关时一并让它退出。

**已验证（Redmi K20 Pro，Android 11）**：`am force-stop dev.projdeck.app` 后 App 进程消失，独立进程还在，电脑上 `adb connect 127.0.0.1:15555` 照常可用，
「设备」页的信息也继续更新（电量读 sysfs，网络看网卡）。独立进程跑在 FlClash 的 VPN 下也能连上服务器。

**注意**：app_process 里 `println` 进 stdout（已重定向到 `/data/local/tmp/projdeck-relay.log`，电脑上 `adb shell cat` 可看）；
R8 会把没人引用的 `RelayMain` 删掉，要在 `proguard-rules.pro` 里 keep（注意是 `android/app/proguard-rules.pro`）。
手机重启后独立进程会消失，需要 App 被拉起（BOOT_COMPLETED，小米要允许「自启动」）再启动它；TCP 模式的自动恢复仍在 App 里。

### 从 Termux、Shizuku、黑阈学到的（2.3.0 续）

- **黑阈**（`brevent/src/main/jni/brevent.c`，开源的旧版本）分两层：一个很小的原生守护进程 `brevent_daemon`
  （`fork` → `setsid` → `chdir("/")` → stdin/out/err 都 `dup2` 到 `/dev/null`），它再 `fork+exec`
  `app_process --nice-name=brevent_server …BreventServer`，并处理 `SIGCHLD`，**服务死了就重新拉起来**（日志里叫 `reborn`）。
  我们照做，但不写原生代码：`setsid nohup sh -c 'while :; do app_process …; rc=$?; [ $rc -eq 0 ] && exit 0; sleep 3; done'`，
  正常退出（收到 `quit`、或已有另一个在运行）返回 0 让循环结束，其他退出 3 秒后重启。
- **Shizuku**（`starter.cpp`）：`fork` → `setsid` → `chdir("/")` → `execvp("app_process", …, ShizukuService)`。
  另外，shell 身份启动的进程会继承 adbd 的 `oom_score_adj = -1000`（实测），低内存时 lmkd 不会杀它。
- **Termux**（`TermuxService.java`）：并没有什么特别的招：前台服务 + 可选的 `PARTIAL_WAKE_LOCK` + `WIFI_MODE_FULL_HIGH_PERF`
  （通知栏上的「Acquire wakelock」按钮），`START_NOT_STICKY`。它的 shell 进程是 App 的子进程，所以其实会被小米的后台清理杀掉；
  这一套 projdeck 的 App 内服务早就有了（2.2.6）。

踩到的坑：libadb 的 `openStream("shell:…")` 按**字符数**而不是字节数算长度，命令里有中文就被截断、什么都不会执行；
shell 没权限读 `/sys/class/power_supply`（SELinux），电量改用 `dumpsys battery`；
独立进程崩溃的 3 秒空档里，App 内的备用转发不能立刻顶上（服务器上后连的顶掉先连的，两边会轮流把对方挤下线），所以等 12 秒。
