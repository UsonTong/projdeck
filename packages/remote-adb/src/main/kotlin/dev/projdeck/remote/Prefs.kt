package dev.projdeck.remote

import android.content.Context

/** 原生这边的设置：通知开关，以及后台连接用的地址和访问 key（由 Dart 在开启通知时传过来）。 */
object Prefs {
    private fun of(c: Context) = c.getSharedPreferences("projdeck_native", Context.MODE_PRIVATE)

    fun notificationsEnabled(c: Context) = of(c).getBoolean("notifications", false)
    fun setNotifications(c: Context, on: Boolean) = of(c).edit().putBoolean("notifications", on).apply()

    fun relayEnabled(c: Context) = of(c).getBoolean("relay", false)
    fun setRelay(c: Context, on: Boolean) = of(c).edit().putBoolean("relay", on).apply()

    /** 这台手机在 projdeck「设备」里的编号：第一次用到时随机生成，之后不变（卸载重装才会变）。 */
    fun deviceId(c: Context): String =
        of(c).getString("device_id", null) ?: java.util.UUID.randomUUID().toString().also { of(c).edit().putString("device_id", it).apply() }

    fun base(c: Context): String? = of(c).getString("base", null)
    fun key(c: Context): String? = of(c).getString("key", null)
    fun setConnection(c: Context, base: String, key: String) = of(c).edit().putString("base", base).putString("key", key).apply()
}
