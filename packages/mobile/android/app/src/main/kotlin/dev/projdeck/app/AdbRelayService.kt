package dev.projdeck.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 远程调试的转发的「看管者」。
 *
 * 真正的转发在独立进程里（[RelayMain]，像 Shizuku 那样用 app_process 启动，小米清理后台杀不到它）。
 * 这个服务负责：
 *  1. 独立进程不在（刚装好、手机重启、版本更新）时，通过 adb 把它启动起来；
 *  2. 在启动成功之前，自己先在 App 里转发（[RelayCore]），不让连接空档；独立进程起来后就交给它；
 *  3. 自动恢复 TCP 模式：手机重启后 5555 会消失，发现了就用 App 自己的授权重新打开。
 */
class AdbRelayService : Service() {
    @Volatile private var running = false
    private var core: RelayCore? = null
    private var superviseThread: Thread? = null
    private var recoveryThread: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onCreate() {
        super.onCreate()
        RelayLog.add(this, "服务创建（进程启动）")
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "远程调试", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        startForeground(
            ID,
            Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification).setContentTitle("远程调试已开启")
                .setContentText("公司电脑可以通过 projdeck 连接这台手机的 adb").setContentIntent(open).setOngoing(true).build(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
        )
        if (!running) {
            running = true
            state = "connecting"
            holdLocks()
            superviseThread = thread(name = "projdeck-adb-supervise") { superviseLoop() }
            recoveryThread = thread(name = "projdeck-adb-recovery") { recoveryLoop() }
        }
        return START_STICKY
    }

    // ---- 看管独立转发进程 ----

    private fun superviseLoop() {
        val mine = RelayProcess.version(this)
        var failures = 0
        var nextLaunch = 0L
        // 独立进程最近一次在运行的时间。它崩溃后外层循环 3 秒内会把它拉起来，所以不在也先等一等再让 App 内的转发顶上，
        // 否则两边会轮流把对方挤下线（服务器上后连的顶掉先连的）
        var lastDetached = System.currentTimeMillis()
        var launchStartedAt = 0L
        var launchThread: Thread? = null
        while (running) {
            try {
                val d = RelayProcess.query()
                if (d != null && d.version == mine) {
                    // 独立进程在正常运行：App 里的备用转发退场，状态以它为准
                    stopCore()
                    lastDetached = System.currentTimeMillis()
                    mode = "detached"
                    state = d.state
                    error = d.error
                    if (launchStartedAt > 0) RelayLog.add(this, "独立转发进程已启动")
                    launchStartedAt = 0
                    failures = 0
                    Thread.sleep(2_000)
                    continue
                }
                if (d != null) {
                    RelayLog.add(this, "独立进程是旧版本（${d.version}），让它退出后重启")
                    RelayProcess.quit()
                    Thread.sleep(1_000)
                }
                // 独立进程不在：在另一个线程里启动它（adb 那头有时要等好几秒才返回），这里继续看着，
                // 起来了就让 App 内的转发退场；启动前 App 内的转发一直开着，不让连接空档
                if (RemoteAdb.tcpReachable() && System.currentTimeMillis() >= nextLaunch && launchThread?.isAlive != true) {
                    val base = Prefs.base(this)
                    val key = Prefs.key(this)
                    if (base != null && key != null) {
                        launchStartedAt = System.currentTimeMillis()
                        launchThread = thread(name = "projdeck-relay-launch") {
                            try {
                                RelayLog.add(this, "启动命令输出：${RemoteAdb.startDetachedRelay(this, base, key)}")
                            } catch (e: Exception) {
                                RelayLog.add(this, "启动命令没有正常返回：${e.javaClass.simpleName}: ${e.message}")
                            }
                        }
                    }
                }
                // 启动命令发出 15 秒后独立进程还没起来，算失败，退避一阵再试
                if (launchStartedAt > 0 && System.currentTimeMillis() - launchStartedAt > 15_000) {
                    launchStartedAt = 0
                    failures++
                    nextLaunch = System.currentTimeMillis() + (30_000L * failures).coerceAtMost(300_000L)
                    RelayLog.add(this, "启动独立转发进程失败（第 $failures 次）")
                }
                // 独立进程崩溃后外层循环 3 秒内会拉起它，所以多等几秒再让 App 内的转发顶上
                if (System.currentTimeMillis() - lastDetached >= 6_000) {
                    mode = "app"
                    startCore()
                }
                Thread.sleep(1_000)
            } catch (_: InterruptedException) {
                break
            }
        }
    }

    /** App 里的备用转发（独立进程起来之前、或始终起不来时用）。 */
    @Synchronized
    private fun startCore() {
        if (core != null) return
        val base = Prefs.base(this)
        val key = Prefs.key(this)
        if (base == null || key == null) {
            error = "还没有服务器地址和访问密钥，请把「远程连接」开关关掉再打开"
            return
        }
        core = RelayCore(
            base, key, RemoteAdb.TCP_PORT,
            log = { Log.i(TAG, it); RelayLog.add(this, it) },
            report = ::report,
            onState = { s, e -> if (mode == "app") { state = s; error = e } },
        ).also { it.start() }
    }

    @Synchronized
    private fun stopCore() {
        core?.stop()
        core = null
    }

    /** 设备自我介绍（「设备」页显示的内容）。 */
    private fun report(): JSONObject {
        val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val cm = getSystemService(ConnectivityManager::class.java)
        @Suppress("DEPRECATION")
        val caps = cm.allNetworks.mapNotNull { cm.getNetworkCapabilities(it) }
        val real = caps.filter { !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) }
        val network = when {
            real.any { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) } -> "wifi"
            real.any { it.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) } -> "mobile"
            else -> "none"
        }
        val json = JSONObject()
            .put("id", Prefs.deviceId(this))
            .put("model", Build.MODEL)
            .put("brand", Build.MANUFACTURER.replaceFirstChar { it.uppercase() })
            .put("os", "Android ${Build.VERSION.RELEASE}")
            .put("network", network)
            .put("vpn", caps.any { it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) })
            .put("tcpMode", RemoteAdb.tcpReachable())
            .put("appVersion", packageManager.getPackageInfo(packageName, 0).versionName)
        if (level >= 0) json.put("battery", level * 100 / scale.coerceAtLeast(1))
        if (status >= 0) json.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
        return json
    }

    /**
     * 保持 CPU 和 Wi-Fi 不休眠：息屏后 Wi-Fi 会进入省电模式、CPU 也会睡，长连接就会被悄悄掐掉。
     * 代价是耗电多一点（和 Termux 开着「唤醒锁」一样）。
     */
    private fun holdLocks() {
        try {
            wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "projdeck:relay").apply { setReferenceCounted(false); acquire() }
            @Suppress("DEPRECATION")
            wifiLock = applicationContext.getSystemService(WifiManager::class.java)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "projdeck:relay").apply { setReferenceCounted(false); acquire() }
        } catch (e: Exception) {
            Log.w(TAG, "获取唤醒锁失败：${e.message}")
        }
    }

    // ---- 自动恢复 TCP 模式 ----

    /**
     * 手机有没有连着 Wi-Fi。不能只看默认网络：开着 FlClash 之类的 VPN 时，默认网络是 VPN 网络，不是 Wi-Fi，
     * 所以要看手机上所有的网络里有没有 Wi-Fi（VPN 自己不算）。
     */
    @Suppress("DEPRECATION")
    private fun onWifi(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java)
        return cm.allNetworks.any { n ->
            val caps = cm.getNetworkCapabilities(n)
            caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        }
    }

    /**
     * 手机重启后 adb 的 TCP 模式会消失。发现 5555 没在监听、又连着 Wi-Fi 时，用 App 自己的授权打开无线调试，
     * 连上它，发 tcpip 切回 TCP 模式（之后不需要 Wi-Fi）。失败时间隔逐步拉长，免得一直耗电。
     */
    private fun recoveryLoop() {
        var wait = 5_000L
        while (running) {
            try {
                Thread.sleep(wait)
            } catch (_: InterruptedException) {
                break
            }
            if (RemoteAdb.tcpReachable()) {
                wait = 10_000L
                continue
            }
            if (!RemoteAdb.paired(this)) {
                RemoteAdb.lastMessage = "还没有配对，无法自动打开 TCP 模式"
                wait = 30_000L
                continue
            }
            if (!onWifi()) {
                RemoteAdb.lastMessage = "TCP 模式没有开，等待连上 Wi-Fi 后自动打开"
                wait = 10_000L
                continue
            }
            Log.i(TAG, "TCP 模式不在了，自动恢复")
            val done = CountDownLatch(1)
            var ok = false
            RemoteAdb.async({ RemoteAdb.enableTcp(this) }) { r ->
                ok = r.isSuccess
                RemoteAdb.lastMessage = r.fold({ "$it（自动）" }, { "自动恢复 TCP 模式失败：${it.message}" })
                if (r.isFailure) Log.w(TAG, "自动恢复失败", r.exceptionOrNull())
                done.countDown()
            }
            done.await(120, TimeUnit.SECONDS)
            wait = if (ok) 10_000L else (wait * 2).coerceIn(30_000L, 300_000L)
        }
    }

    override fun onDestroy() {
        RelayLog.add(this, "服务停止（被系统杀掉或手动关闭）；独立转发进程不受影响")
        runCatching { wakeLock?.release() }
        runCatching { wifiLock?.release() }
        running = false
        state = "off"
        stopCore()
        superviseThread?.interrupt()
        recoveryThread?.interrupt()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "ProjdeckAdb"
        private const val CHANNEL = "adb_relay"
        private const val ID = 4
        /** off / connecting / connected */
        @Volatile var state = "off"

        /** 最近一次连不上的原因，连上后清空；显示在「远程 adb」页上 */
        @Volatile var error: String? = null

        /** app：转发在 App 里跑（备用）；detached：转发在独立进程里跑 */
        @Volatile var mode = "app"

        fun start(c: Context) {
            c.startForegroundService(Intent(c, AdbRelayService::class.java))
        }

        /** 用户关掉「远程连接」：连独立转发进程也一起停掉。 */
        fun stop(c: Context) {
            c.stopService(Intent(c, AdbRelayService::class.java))
            thread(name = "projdeck-relay-quit") { RelayProcess.quit() }
        }
    }
}
