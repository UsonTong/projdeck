#!/bin/bash
# 编译 CC Switch 的前端（与电脑上安装的版本一致），给 projdeck 在电脑浏览器里显示它原版的界面。
# 界面里的操作由 projdeck 转给电脑上正在运行的 CC Switch 执行（见 packages/agentd/src/ccswitchBridge.ts）。
# 用法：deploy/ccswitch-ui/build.sh [版本]，默认取已安装的 cc-switch 的版本。产物在 ~/.cache/projdeck/cc-switch-ui/<版本>/
set -euo pipefail
version="${1:-$(rpm -q --qf '%{VERSION}' cc-switch 2>/dev/null || true)}"
[ -n "$version" ] || { echo "没有找到 cc-switch 的版本，请作为参数传入" >&2; exit 1; }
src="$HOME/.cache/projdeck/cc-switch-src/$version"
out="$HOME/.cache/projdeck/cc-switch-ui/$version"
if [ ! -d "$src/.git" ]; then
  rm -rf "$src"
  git clone --depth 1 --branch "v$version" https://github.com/farion1231/cc-switch.git "$src"
fi
cd "$src"
pnpm install --frozen-lockfile --ignore-scripts
# 资源用相对路径，挂在 projdeck 的 /ccswitch-ui/ 下
pnpm exec vite build --base ./ --outDir "$out.tmp" --emptyOutDir
rm -rf "$out"
mv "$out.tmp" "$out"
echo "已编译到 $out"
