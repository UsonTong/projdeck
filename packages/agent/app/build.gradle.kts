import java.util.Properties

// 与 projdeck App 用同一把签名密钥（也可以单独换）
val keystoreProps = Properties().apply {
    val f = File(System.getProperty("user.home"), ".config/projdeck/android/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

plugins {
    id("com.android.application")
}

android {
    namespace = "dev.projdeck.agent"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.projdeck.agent"
        minSdk = 30
        targetSdk = 36
        // 版本号用发布时间（2026 年起的分钟数），每次发布都比上一次大
        versionCode = ((System.currentTimeMillis() / 1000 - 1767225600L) / 60).toInt()
        versionName = "1.0.0"
    }

    signingConfigs {
        create("release") {
            if (keystoreProps.isNotEmpty()) {
                storeFile = File(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    implementation(project(":remote-adb"))
}
