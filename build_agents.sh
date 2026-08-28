#!/usr/bin/env bash
# host-relay agent 交叉编译脚本
# Go 路径集中为常量 (可用环境变量 GO_BIN 覆盖, 便于换机器/升级 Go)
# 用法:  bash build_agents.sh
set -euo pipefail

# ---- 常量配置区 ----
GO_BIN="${GO_BIN:-C:/Users/Administrator/sdk/go/bin/go.exe}"
# 本机 go1.22.5 直编, 禁止自动换链 (否则会去 proxy.golang.org 拉新版工具链,
# 该代理不可达会导致 arm64 目标失败; 锁本地链最稳)
export GOTOOLCHAIN=local

# 版本号单一真相源: 只改 version.txt 一处, agent 二进制 / worker.js 下载链接 / release tag 全部同步
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION_FILE="$REPO_ROOT/version.txt"
VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
# -X 只能覆盖 var (main.go 的 version 已改为 var), 不可用于 const
LDFLAGS="-X main.version=${VERSION}"

AGENT_DIR="$REPO_ROOT/src/agent"
OUT="$AGENT_DIR/out"
mkdir -p "$OUT"

# 同步 worker.js 的 VERSION 常量, 使线上面板下载链接与二进制版本一致
WORKER_JS="$REPO_ROOT/src/worker/worker.js"
if [ -f "$WORKER_JS" ]; then
  if grep -q "const VERSION = '${VERSION}'" "$WORKER_JS"; then
    echo "worker.js VERSION already $VERSION (no change)"
  else
    sed -i.bak -E "s/(const VERSION = ')[^']+(';)/\1${VERSION}\2/" "$WORKER_JS"
    rm -f "$WORKER_JS.bak"
    echo "Synced worker.js VERSION -> $VERSION"
  fi
else
  echo "WARN: $WORKER_JS not found, skip worker VERSION sync"
fi

# 目标: os/arch/输出文件名
TARGETS=(
  "linux/amd64/agent-linux-amd64"
  "linux/arm64/agent-linux-arm64"
  "linux/386/agent-linux-386"
  "linux/arm/agent-linux-arm"
  "darwin/amd64/agent-darwin-amd64"
  "darwin/arm64/agent-darwin-arm64"
  "windows/amd64/agent-windows-amd64.exe"
)

echo "Using Go : $GO_BIN"
echo "Version  : $VERSION (injected via ldflags)"
"$GO_BIN" version

for t in "${TARGETS[@]}"; do
  os="${t%%/*}"; rest="${t#*/}"
  arch="${rest%%/*}"; name="${rest#*/}"
  # 注意: -o 必须用相对路径。绝对 POSIX 路径(/c/Users/...)传给 go.exe(Windows 程序)时
  # Git Bash 不做路径转换,go 会把它解释成 C:\c\Users\... 静默写到错误目录!
  ( cd "$AGENT_DIR" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
      "$GO_BIN" build -ldflags "$LDFLAGS" -o "out/$name" . ) \
    && echo "OK   $os/$arch -> $name" \
    || { echo "FAIL $os/$arch"; exit 1; }
done

echo "=== built ${#TARGETS[@]} binaries in $OUT ==="
ls -la "$OUT"
