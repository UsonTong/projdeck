#!/bin/bash
# 编译「projdeck 被控端」并发布到 projdeck：网页的「设备」页里可以下载，装到要远程控制的手机上。
# 产物：~/.cache/projdeck/android/projdeck-agent.apk + projdeck-agent.json
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-$HOME/.cache/jdk-21}" ANDROID_HOME="${ANDROID_HOME:-$HOME/.cache/moyu-android-sdk}"
./gradlew :app:assembleRelease -q --console=plain
out="$HOME/.cache/projdeck/android"
mkdir -p "$out"
cp app/build/outputs/apk/release/app-release.apk "$out/projdeck-agent.apk.tmp"
mv "$out/projdeck-agent.apk.tmp" "$out/projdeck-agent.apk"
code=$(grep -m1 'versionCode =' app/build.gradle.kts >/dev/null; unzip -p "$out/projdeck-agent.apk" 2>/dev/null >/dev/null; echo)
version=$($ANDROID_HOME/build-tools/36.0.0/aapt2 dump badging "$out/projdeck-agent.apk" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p" | head -1)
printf '{"version":"%s","size":%d,"builtAt":"%s"}\n' "${version:-1.0.0}" "$(stat -c %s "$out/projdeck-agent.apk")" "$(date -Iseconds)" > "$out/projdeck-agent.json"
echo "已发布 ${version:-1.0.0} 到 $out/projdeck-agent.apk"
