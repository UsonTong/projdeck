# libadb-android 通过类名反射加载 Conscrypt 的 OpenSSLProvider，TLS 配对需要它
-keep class org.conscrypt.** { *; }
-keep class io.github.muntashirakon.adb.** { *; }
-keep class android.sun.security.** { *; }
-dontwarn org.conscrypt.**
-dontwarn android.sun.security.**
-dontwarn com.android.org.conscrypt.**
-dontwarn javax.naming.**

# 独立转发进程由 app_process 按类名启动
-keep class dev.projdeck.app.RelayMain { public static void main(java.lang.String[]); }
