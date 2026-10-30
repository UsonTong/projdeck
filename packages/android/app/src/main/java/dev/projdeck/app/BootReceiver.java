package dev.projdeck.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 开机、App 更新后，如果开着通知就恢复后台通知连接。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Prefs.notificationsEnabled(context)) NotifyService.start(context);
    }
}
