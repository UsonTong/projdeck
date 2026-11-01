import java.util.Properties

// 签名用的密钥不放进仓库：~/.config/projdeck/android/keystore.properties（与之前的安卓外壳同一把，可以覆盖安装）
val keystoreProps = Properties().apply {
    val f = File(System.getProperty("user.home"), ".config/projdeck/android/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "dev.projdeck.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "dev.projdeck.app"
        minSdk = 30
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
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
            signingConfig = signingConfigs.getByName("release")
            // libadb-android 和 Conscrypt 里有按名字反射加载的类，不能被混淆或裁掉
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

dependencies {
    // 远程调试：App 里的 adb 客户端（无线调试配对、TLS 连接）
    implementation("com.github.MuntashirAkon:libadb-android:3.1.1")
    // 生成连接 adbd 用的 X509 证书（库的 README 推荐）
    implementation("com.github.MuntashirAkon:sun-security-android:1.1")
    // TLS 1.3：系统自带的 Conscrypt 不能直接用，自带一份，库发现它就会自动使用
    implementation("org.conscrypt:conscrypt-android:2.5.3")
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
