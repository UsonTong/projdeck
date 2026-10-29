#!/usr/bin/env bash
# 编译提高帧率的 herdr 并无缝切换过去（不关闭任何 pane）。
#
# herdr 把渲染间隔写死为 16ms（约 60 帧），网页终端和本机客户端都被限制在 60 帧。
# render-interval.patch 把它改为 4ms。herdr 官方更新会覆盖 ~/.local/bin/herdr，更新后重新运行本脚本即可。
#
# 用法：deploy/herdr/build.sh [版本标签，默认为当前安装的版本，如 v0.9.5]
# 需要：rustup（~/.cargo/bin）、Zig 0.16（~/.local/opt/zig-x86_64-linux-0.16.0）、cmake、ninja。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="$HOME/.local/bin/herdr"
tag="${1:-v$("$bin" --version | awk '{print $2}')}"
src="${HERDR_SRC:-$HOME/.cache/projdeck/herdr-src}"
export PATH="$HOME/.cargo/bin:$HOME/.local/opt/zig-x86_64-linux-0.16.0:$PATH"
export ZIG="$HOME/.local/opt/zig-x86_64-linux-0.16.0/zig"

echo "==> 获取 herdr $tag 源码"
if [[ -d "$src/.git" ]]; then
  git -C "$src" fetch -q --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
  git -C "$src" checkout -q -f "$tag"
else
  git clone -q --depth 1 --branch "$tag" https://github.com/herdrdev/herdr.git "$src"
fi
git -C "$src" apply "$here/render-interval.patch"

echo "==> 编译（首次约 4 分钟）"
(cd "$src" && cargo build --release --locked)

echo "==> 安装"
[[ -f "$bin-official" ]] || cp -p "$bin" "$bin-official"   # 第一次运行时保留官方版，便于换回
cp "$src/target/release/herdr" "$bin.new" && mv "$bin.new" "$bin"
git -C "$src" checkout -q -- .

echo "==> 切换正在运行的服务端"
# 交接后每个 pane 的 terminal ID 会变（pane ID 不变）。projdeck 按 terminal ID 记录归属、隐藏等状态，
# 发现 ID 消失就会清理，所以先停 projdeck，交接后按 pane ID 迁移状态再启动。
state="$HOME/.config/projdeck/state.json"
list() { env -u HERDR_SOCKET_PATH "$bin" pane list | python3 -c 'import json,sys; d=json.load(sys.stdin); ps=d.get("result",d); ps=ps.get("panes",ps) if isinstance(ps,dict) else ps; print(json.dumps({p["pane_id"]: p["terminal_id"] for p in ps}))'; }
before="$(list)"
systemctl --user stop projdeck-agentd || true
env -u HERDR_SOCKET_PATH "$bin" server live-handoff --import-exe "$bin"
sleep 2
after="$(list)"
if [[ -f "$state" ]]; then
  python3 - "$state" "$before" "$after" <<'PY'
import json, sys
path, before, after = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
m = {before[p]: after[p] for p in before if p in after}
s = json.load(open(path))
s["sticky"] = {m.get(k, k): v for k, v in s.get("sticky", {}).items()}
s["codexOverrides"] = {m.get(k, k): v for k, v in s.get("codexOverrides", {}).items()}
for key in ("hiddenTerminals", "seenDone"):
    s[key] = [m.get(t, t) for t in s.get(key, [])]
json.dump(s, open(path, "w"), indent=2, ensure_ascii=False)
print(f"projdeck 状态已迁移（{len(m)} 个 pane）")
PY
fi
systemctl --user start projdeck-agentd || true
echo "完成：$("$bin" --version)，渲染间隔 4ms"
