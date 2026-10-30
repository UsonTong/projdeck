package dev.projdeck.app

import android.content.Context

/** 原生这边的设置：通知开关，以及后台连接用的地址和访问 key（由 Dart 在开启通知时传过来）。 */
object Prefs {
    private fun of(c: Context) = c.getSharedPreferences("projdeck_native", Context.MODE_PRIVATE)

    fun notificationsEnabled(c: Context) = of(c).getBoolean("notifications", false)
    fun setNotifications(c: Context, on: Boolean) = of(c).edit().putBoolean("notifications", on).apply()

    fun base(c: Context): String? = of(c).getString("base", null)
    fun key(c: Context): String? = of(c).getString("key", null)
    fun setConnection(c: Context, base: String, key: String) = of(c).edit().putString("base", base).putString("key", key).apply()
}
