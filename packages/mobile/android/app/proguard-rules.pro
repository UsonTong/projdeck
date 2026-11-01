# libadb-android 通过类名反射加载 Conscrypt 的 OpenSSLProvider，TLS 配对需要它
-keep class org.conscrypt.** { *; }
-keep class io.github.muntashirakon.adb.** { *; }
-keep class android.sun.security.** { *; }
-dontwarn org.conscrypt.**
-dontwarn android.sun.security.**
-dontwarn com.android.org.conscrypt.**
-dontwarn javax.naming.**
