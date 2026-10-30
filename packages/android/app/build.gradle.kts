import java.util.Properties

plugins {
    id("com.android.application")
}

// 签名用的密钥不放进仓库：~/.config/projdeck/android/keystore.properties（storeFile、storePassword、keyAlias、keyPassword）
val keystoreProps = Properties().apply {
    val f = File(System.getProperty("user.home"), ".config/projdeck/android/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "dev.projdeck.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.projdeck.app"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        // projdeck 的公网地址；编译时可用 -Pprojdeck.server=https://… 覆盖
        val server = (project.findProperty("projdeck.server") as String?) ?: "https://120.26.194.174:18420"
        buildConfigField("String", "SERVER", "\"$server\"")
    }

    buildFeatures {
        buildConfig = true
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
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
