package dev.projdeck.agent

import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import dev.projdeck.remote.AdbPairingService
import dev.projdeck.remote.AdbRelayService
import dev.projdeck.remote.Prefs
import dev.projdeck.remote.RelayProcess
import dev.projdeck.remote.RemoteAdb

/**
 * projdeck 被控端的界面：只管「被电脑上的 projdeck 远程控制这台手机」这一件事。
 *
 * 和 projdeck App 里的「远程 adb」页是同一套底层（共用 remote-adb 模块）：配对一次、授权一次、切到 TCP 模式，
 * 之后打开「远程连接」，手机就能被电脑上的 adb 连到。整个过程不占用 VPN，可以和 FlClash 同时用。
 */
class MainActivity : android.app.Activity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var statusText: TextView
    private lateinit var relaySwitch: Switch
    private lateinit var baseField: EditText
    private lateinit var keyField: EditText
    private lateinit var steps: LinearLayout
    private lateinit var messageText: TextView
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(build())
        refresh()
        main.postDelayed(refreshTask, 1500)
    }

    /** 回到前台时确保转发在跑（被系统清理后重新打开 App、更新 App 后）。进程刚起来时系统会拒绝启动前台服务，所以要在这里。 */
    override fun onResume() {
        super.onResume()
        try {
            if (Prefs.relayEnabled(this)) AdbRelayService.start(this)
        } catch (_: Exception) {
            // 下一次刷新再看状态
        }
    }

    override fun onDestroy() {
        main.removeCallbacks(refreshTask)
        super.onDestroy()
    }

    private val refreshTask = object : Runnable {
        override fun run() {
            refresh()
            main.postDelayed(this, 2000)
        }
    }

    // ---- 界面 ----

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun card(child: android.view.View, pad: Int = 16): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(pad), dp(pad), dp(pad), dp(pad))
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat()
                setColor(Color.parseColor("#1B1A17"))
                setStroke(dp(1), Color.parseColor("#2E2C27"))
            }
            addView(child, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }

    private fun text(s: String, size: Float = 14f, color: String = "#EDEAE3", bold: Boolean = false): TextView =
        TextView(this).apply {
            text = s
            textSize = size
            setTextColor(Color.parseColor(color))
            if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        }

    private fun button(label: String, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            setOnClickListener { if (!busy) onClick() }
        }

    private fun build(): ScrollView {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(24), dp(16), dp(32))
        }
        col.addView(text("projdeck 被控端", 22f, bold = true))
        col.addView(text("让电脑上的 projdeck 通过 adb 远程控制这台手机。不需要 root，不占用 VPN，可以和 FlClash 同时开。", 13f, "#9A958A").apply {
            setPadding(0, dp(6), 0, dp(16))
        })

        // 服务器与密钥
        baseField = EditText(this).apply {
            hint = "服务器地址，例如 https://120.26.194.174:18420"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(Prefs.base(this@MainActivity) ?: "")
        }
        keyField = EditText(this).apply {
            hint = "访问密钥（和网页登录用的一样）"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            setText(Prefs.key(this@MainActivity) ?: "")
        }
        val save = button("保存并连接") { saveConnection() }
        col.addView(card(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text("服务器", 13f, "#9A958A"))
            addView(baseField)
            addView(text("访问密钥", 13f, "#9A958A"))
            addView(keyField)
            addView(save)
        }))
        col.addView(space(12))

        // 状态
        statusText = text("", 14f)
        val relayRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(text("远程连接", 16f, bold = true), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            relaySwitch = Switch(this@MainActivity).apply {
                setOnCheckedChangeListener { _, on ->
                    if (busy) return@setOnCheckedChangeListener
                    Prefs.setRelay(this@MainActivity, on)
                    if (on) AdbRelayService.start(this@MainActivity) else AdbRelayService.stop(this@MainActivity)
                    main.postDelayed({ refresh() }, 600)
                }
            }
            addView(relaySwitch)
        }
        col.addView(card(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(relayRow)
            addView(statusText.apply { setPadding(0, dp(6), 0, 0) })
        }))
        col.addView(space(12))

        // 三步
        steps = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(card(steps))
        col.addView(space(12))

        // 保活
        messageText = text("", 12f, "#9A958A")
        col.addView(card(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text("让它在后台一直在线", 15f, bold = true))
            addView(button("打开无障碍（配对助手）") {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            })
            addView(button("电池不受限制") { batteryUnrestricted() })
            addView(button("允许自启动") { autostart() })
            addView(messageText.apply { setPadding(0, dp(8), 0, 0) })
        }))
        col.addView(space(12))
        col.addView(text("配对只需要一次。之后手机只负责保持「远程连接」开着；电脑上在 projdeck 的「设备」页可以看到它。", 12f, "#9A958A"))

        return ScrollView(this).apply { addView(col) }
    }

    private fun space(h: Int) = android.view.View(this).apply { layoutParams = LinearLayout.LayoutParams(1, dp(h)) }

    private fun saveConnection() {
        val base = baseField.text.toString().trim().trimEnd('/')
        val key = keyField.text.toString().trim()
        if (!base.startsWith("http")) return toast("服务器地址要以 http:// 或 https:// 开头")
        if (key.isEmpty()) return toast("请填写访问密钥")
        Prefs.setConnection(this, base, key)
        Prefs.setRelay(this, true)
        relaySwitch.isChecked = true
        AdbRelayService.start(this)
        toast("已保存，正在连接")
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private fun batteryUnrestricted() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
    }

    private fun autostart() {
        val candidates = listOf(
            Intent().setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            Intent().setClassName("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
            Intent().setClassName("com.oplus.battery", "com.oplus.startupapp.view.StartupAppListActivity"),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")),
        )
        for (i in candidates) {
            try {
                startActivity(i)
                return
            } catch (_: Exception) {
                // 换下一个
            }
        }
    }

    // ---- 状态 ----

    private fun refresh() {
        RemoteAdb.async({ RemoteAdb.status(this) }) { r ->
            val s = r.getOrNull() ?: return@async
            val detached = RelayProcess.query()
            val relay = (s["relay"] as? String) ?: "off"
            val error = (s["relayError"] as? String).orEmpty()
            val state = when {
                s["relayEnabled"] != true -> "已关闭"
                relay == "connected" -> "已连上服务器" + if (s["relayMode"] == "detached") "（独立进程，清理后台不受影响）" else "（正在转入独立进程）"
                else -> "正在连接服务器…" + if (error.isNotEmpty()) "（$error）" else ""
            }
            statusText.text = state
            statusText.setTextColor(Color.parseColor(if (relay == "connected" && s["relayEnabled"] == true) "#5FBF7F" else "#9A958A"))
            relaySwitch.isChecked = s["relayEnabled"] == true
            steps.removeAllViews()
            steps.addView(text("设置步骤", 15f, bold = true))
            val paired = s["paired"] == true
            val granted = s["secureGranted"] == true
            val tcp = s["tcp"] == true
            steps.addView(stepRow("配对", paired, if (paired) "已配对，以后不用再配" else if (s["accessibility"] == true) "点「开始配对」，然后在无线调试里点「使用配对码配对」" else "先打开无障碍里的「远程调试配对助手」") {
                if (s["accessibility"] != true) startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                else {
                    AdbPairingService.start(this)
                    try {
                        startActivity(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))
                    } catch (_: Exception) {
                        startActivity(Intent(Settings.ACTION_SETTINGS))
                    }
                }
            })
            steps.addView(stepRow("授权", granted, if (granted) "已授权，App 能自己开关无线调试" else "让 App 拥有开关无线调试的权限，之后重启能自动恢复") {
                run("授权中…") { RemoteAdb.grantSelf(this) }
            })
            steps.addView(stepRow("TCP 模式", tcp, if (tcp) "adb 已在 5555 端口监听" else "把 adb 切到 TCP 模式，之后不需要 Wi-Fi") {
                run("切换中…") { RemoteAdb.enableTcp(this) }
            })
            messageText.text = (s["message"] as? String).orEmpty() + if (detached != null && detached.state != "connected" && detached.error != null) "\n${detached.error}" else ""
        }
    }

    private fun stepRow(title: String, done: Boolean, detail: String, action: () -> Unit): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(10), 0, dp(2))
            val top = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(text((if (done) "✓ " else "○ ") + title, 15f, if (done) "#5FBF7F" else "#EDEAE3", bold = true), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                if (!done) addView(button(if (title == "配对") "开始配对" else if (title == "授权") "授权" else "开启") { action() })
            }
            addView(top)
            addView(text(detail, 12f, "#9A958A").apply { setPadding(0, dp(2), 0, 0) })
        }

    private fun run(label: String, work: () -> String) {
        busy = true
        toast(label)
        RemoteAdb.async(work) { r ->
            busy = false
            toast(r.fold({ it }, { it.message ?: "失败" }))
            refresh()
        }
    }
}
