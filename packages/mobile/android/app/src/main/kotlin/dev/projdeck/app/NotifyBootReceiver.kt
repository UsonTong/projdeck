package dev.projdeck.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.projdeck.remote.Prefs

/** 开机、App 更新后，如果开着通知就恢复后台通知连接（远程连接的恢复由共用库里的接收器负责）。 */
class NotifyBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs.notificationsEnabled(context)) NotifyService.start(context)
    }
}
