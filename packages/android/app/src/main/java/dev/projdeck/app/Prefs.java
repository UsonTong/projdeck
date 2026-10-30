package dev.projdeck.app;

import android.content.Context;
import android.content.SharedPreferences;

/** App 的设置（保存在手机上）。 */
final class Prefs {
    private Prefs() {}

    private static SharedPreferences of(Context c) {
        return c.getSharedPreferences("projdeck", Context.MODE_PRIVATE);
    }

    static boolean notificationsEnabled(Context c) {
        return of(c).getBoolean("notifications", false);
    }

    static void setNotifications(Context c, boolean on) {
        of(c).edit().putBoolean("notifications", on).apply();
    }
}
