#!/bin/bash
# 编译安卓 App 并发布到 projdeck：手机在网页的「设置 → 安卓 App」里下载安装，不用连电脑。
# 产物放在 ~/.cache/projdeck/android/（projdeck.apk + version.json），agentd 从那里提供下载。
set -euo pipefail
cd "$(dirname "$0")"
export PATH=/opt/development/flutter/bin:$PATH
export ANDROID_HOME="${ANDROID_HOME:-$HOME/.cache/moyu-android-sdk}" JAVA_HOME="${JAVA_HOME:-$HOME/.cache/jdk-21}"
# 版本号用发布时间（2026 年起的分钟数），每次发布都比上一次大，手机才会当作升级
build=$(( ($(date +%s) - 1767225600) / 60 ))
flutter build apk --release --target-platform android-arm64 --build-number "$build"
out="$HOME/.cache/projdeck/android"
mkdir -p "$out"
cp build/app/outputs/flutter-apk/app-release.apk "$out/projdeck.apk.tmp"
mv "$out/projdeck.apk.tmp" "$out/projdeck.apk"
version="$(grep -m1 '^version:' pubspec.yaml | awk '{print $2}' | cut -d+ -f1)+$build"
printf '{"version":"%s","size":%d,"builtAt":"%s"}\n' "$version" "$(stat -c %s "$out/projdeck.apk")" "$(date -Iseconds)" > "$out/version.json"
echo "已发布 $version 到 $out"
