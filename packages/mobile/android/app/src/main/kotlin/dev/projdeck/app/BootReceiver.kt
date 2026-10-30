package dev.projdeck.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机、App 更新后，如果开着通知就恢复后台通知连接。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs.notificationsEnabled(context)) NotifyService.start(context)
    }
}
