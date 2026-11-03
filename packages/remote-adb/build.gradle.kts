/*
 * 远程调试（被控端）的公共部分：配对、授权、TCP 模式、转发（App 内 + 独立进程）、开机恢复。
 * projdeck App 和独立的「projdeck 被控端」App 共用这一份，界面各自实现。
 */
plugins {
    id("com.android.library")
}

android {
    namespace = "dev.projdeck.remote"
    compileSdk = 36

    defaultConfig {
        minSdk = 30
        consumerProguardFiles("proguard-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // 用 api：两个 App 都可能直接用到这些类型（Conscrypt、证书相关的类）
    api("com.github.MuntashirAkon:libadb-android:3.1.1")
    api("com.github.MuntashirAkon:sun-security-android:1.1")
    api("org.conscrypt:conscrypt-android:2.5.3")
    api("com.squareup.okhttp3:okhttp:4.12.0")
    api("org.json:json:20240303")
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}
