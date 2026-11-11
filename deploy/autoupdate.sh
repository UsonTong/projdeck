#!/bin/bash
# 从 GitHub Release（固定 tag: latest）拉取网页和安卓 App 的构建产物，部署到本机。
# 由 projdeck-autoupdate.timer 定期触发；只在有比本地新的构建时下载。
set -euo pipefail

REPO="UsonTong/projdeck"
BASE="https://github.com/$REPO/releases/download/latest"
REPO_DIR="$HOME/Repositories/projdeck"
WEB_DIST="$REPO_DIR/packages/web/dist"
APK_DIR="$HOME/.cache/projdeck/android"
STATE_DIR="$HOME/.cache/projdeck/update"

mkdir -p "$STATE_DIR" "$APK_DIR"

# 1. 最新构建的 commit（version.json 里有）。下载失败（网络、Release 还不存在）就安静退出，下轮再试
version_json="$(curl -fsSL "$BASE/version.json" 2>/dev/null || true)"
[ -n "$version_json" ] || { echo "拉取 version.json 失败，跳过本轮"; exit 0; }
commit="$(printf '%s' "$version_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("commit",""))' 2>/dev/null || true)"
[ -n "$commit" ] || { echo "version.json 缺少 commit，跳过"; exit 0; }

# 2. 已是当前版本就不动
if [ "$commit" = "$(cat "$STATE_DIR/commit" 2>/dev/null || true)" ]; then
  exit 0
fi
echo "发现新构建 $commit，开始更新…"

# 3. 网页：下载、解压到临时目录，再原子替换（fastify-static 按需读文件，替换后下次请求即新版本）
curl -fsSL "$BASE/web-dist.tar.gz" -o "$STATE_DIR/web-dist.tar.gz"
rm -rf "$STATE_DIR/dist"
tar -xzf "$STATE_DIR/web-dist.tar.gz" -C "$STATE_DIR"   # 得到 $STATE_DIR/dist
rm -rf "$WEB_DIST.old"
[ -e "$WEB_DIST" ] && mv "$WEB_DIST" "$WEB_DIST.old"
mv "$STATE_DIR/dist" "$WEB_DIST"
rm -rf "$WEB_DIST.old"
echo "网页已更新"

# 4. 安卓 App：下载 APK 和 version.json（手机端读 version.json 判断升级）
curl -fsSL "$BASE/projdeck.apk" -o "$APK_DIR/projdeck.apk.tmp"
mv "$APK_DIR/projdeck.apk.tmp" "$APK_DIR/projdeck.apk"
printf '%s' "$version_json" > "$APK_DIR/version.json"
echo "安卓 App 已更新"

# 5. 记录当前版本
printf '%s' "$commit" > "$STATE_DIR/commit"
echo "更新完成 $commit"
