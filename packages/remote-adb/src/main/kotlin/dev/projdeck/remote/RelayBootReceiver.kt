package dev.projdeck.remote

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机、App 更新后，如果「远程连接」开着就把转发恢复起来（通知连接由各个 App 自己的接收器处理）。 */
class RelayBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs.relayEnabled(context)) AdbRelayService.start(context)
    }
}
