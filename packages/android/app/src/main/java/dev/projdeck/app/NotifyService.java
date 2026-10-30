package dev.projdeck.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.webkit.CookieManager;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * 后台通知：与电脑上的 projdeck 保持一条 Server-Sent Events 连接（/api/notify/stream），
 * Claude / Codex 完成或需要处理时显示系统通知，点通知打开对应的会话。
 * 不经过谷歌的推送服务，国内网络也能收到。安卓要求后台常驻的连接显示一条常驻通知。
 */
public class NotifyService extends Service {
    static final String EXTRA_PATH = "dev.projdeck.app.PATH";
    private static final String CHANNEL_STATUS = "status";
    private static final String CHANNEL_ALERTS = "alerts";
    private static final int ID_STATUS = 1;

    private volatile boolean running;
    private volatile HttpURLConnection current;
    private Thread worker;

    static void start(Context c) {
        c.startForegroundService(new Intent(c, NotifyService.class));
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, NotifyService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel status = new NotificationChannel(CHANNEL_STATUS, "后台连接", NotificationManager.IMPORTANCE_MIN);
        status.setDescription("保持与电脑的连接，用来接收通知（可以在系统设置里把这一类隐藏）");
        status.setShowBadge(false);
        nm.createNotificationChannel(status);
        NotificationChannel alerts = new NotificationChannel(CHANNEL_ALERTS, "完成和需处理", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Claude / Codex 完成了，或者在等你确认");
        nm.createNotificationChannel(alerts);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification ongoing = new Notification.Builder(this, CHANNEL_STATUS)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("projdeck 正在接收通知")
                .setContentIntent(openApp(null, 0))
                .setOngoing(true)
                .build();
        startForeground(ID_STATUS, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        if (!running) {
            running = true;
            worker = new Thread(this::loop, "projdeck-notify");
            worker.start();
        }
        return START_STICKY;
    }

    /** 断线后重连，间隔从 2 秒逐步加到 1 分钟；连上后复位。 */
    private void loop() {
        long backoff = 2_000;
        while (running) {
            try {
                listen();
                backoff = 2_000;
            } catch (Exception ignored) {
                // 网络切换、电脑休眠等，稍后重连
            }
            if (!running) break;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                break;
            }
            backoff = Math.min(backoff * 2, 60_000);
        }
    }

    private void listen() throws Exception {
        String base = BuildConfig.SERVER;
        HttpURLConnection conn = (HttpURLConnection) new URL(base + "/api/notify/stream").openConnection();
        current = conn;
        String cookie = CookieManager.getInstance().getCookie(base);
        if (cookie != null) conn.setRequestProperty("Cookie", cookie);
        conn.setRequestProperty("Accept", "text/event-stream");
        conn.setConnectTimeout(15_000);
        // 服务器每 25 秒发一次心跳，超过 70 秒没有任何数据就认为断了
        conn.setReadTimeout(70_000);
        try {
            if (conn.getResponseCode() != 200) throw new Exception("HTTP " + conn.getResponseCode());
            try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while (running && (line = r.readLine()) != null) {
                    if (line.startsWith("data: ")) show(new JSONObject(line.substring(6)));
                }
            }
        } finally {
            conn.disconnect();
            current = null;
        }
    }

    private void show(JSONObject p) {
        String tag = p.optString("tag", "projdeck");
        Notification n = new Notification.Builder(this, CHANNEL_ALERTS)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(p.optString("title", "projdeck"))
                .setContentText(p.optString("body", ""))
                .setStyle(new Notification.BigTextStyle().bigText(p.optString("body", "")))
                .setContentIntent(openApp(p.optString("url", "/#/"), tag.hashCode()))
                .setAutoCancel(true)
                .build();
        // 同一个会话的新通知替换旧的
        getSystemService(NotificationManager.class).notify(tag, 2, n);
    }

    private PendingIntent openApp(String path, int requestCode) {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) i.putExtra(EXTRA_PATH, path);
        return PendingIntent.getActivity(this, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection c = current;
        if (c != null) new Thread(c::disconnect).start();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
