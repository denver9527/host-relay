#!/usr/bin/env bash
# host-relay 部署脚本 —— 部署到 cld2 账户 (cgq7139@139.com), zone hi315.us.ci
#
# 前置条件:
#   1. 网络出口能直连 https://api.cloudflare.com 的 PUT/POST/上传 (multipart)。
#      ⚠️ 若身处「仅放行 GET/POST、破坏 multipart 上传」的受限出口,
#         请先开启 Cloudflare WARP 连 Zero Trust 绕过本地代理再跑本脚本。
#   2. 已安装 Node.js (含 npx / wrangler)。推荐用 WorkBuddy 托管 Node:
#      C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe
#      与 C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/wrangler
#   3. cld2.txt 含: 第2行=账户ID, 第5行=高权限api令牌(cfut_)
#
# 用法:
#   bash deploy-cf.sh [/path/to/cld2.txt]
#
# 说明:
#   - 用官方 wrangler 上传 worker.js (自动带 DO 绑定 HUB/HOST + migration v1),
#     这是本账户新版 API (api-version 2026-09-25) 下唯一可靠的上传方式;
#     手写 curl multipart 会被 CF 当成「传统 Service Worker」报 10021。
#   - 自动生成并写入 3 个 Secret: ADMIN_PASSWORD(随机, 存到 E:/host_relay_adminpw.txt)
#     / SESSION_SECRET / TICKET_KEY
#   - 在 hi315.us.ci 建 Worker 路由; workers.dev 子域
#     host-relay.cgq7139-41f.workers.dev 部署后自动可用, 无需 DNS。
set -euo pipefail

C2="${1:-/e/cld2.txt}"
[ -f "$C2" ] || { echo "找不到 cld2.txt: $C2"; exit 1; }

# --- 读取凭据 (不回显) ---
TOKEN=$(sed -n '5p' "$C2" | tr -d '\r')
ACCT=$(sed -n '2p' "$C2" | tr -d '\r')
[ -n "$TOKEN" ] && [ -n "$ACCT" ] || { echo "cld2.txt 解析失败"; exit 1; }

# --- 定位 Node / wrangler ---
NODE_BIN="${NODE_BIN:-C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe}"
WRANGLER="${WRANGLER:-C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/wrangler/bin/wrangler.js}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
[ -f "$WRANGLER" ] || WRANGLER="$(command -v wrangler || true)"
[ -n "$NODE_BIN" ] || { echo "找不到 node"; exit 1; }
[ -n "$WRANGLER" ] || { echo "找不到 wrangler (npm i wrangler)"; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
WCONF="$DIR/src/worker/wrangler.toml"
[ -f "$WCONF" ] || { echo "找不到 $WCONF"; exit 1; }

export CLOUDFLARE_API_TOKEN="$TOKEN"
export CLOUDFLARE_ACCOUNT_ID="$ACCT"

echo "==> 部署 worker (wrangler) ..."
"$NODE_BIN" "$WRANGLER" deploy --config "$WCONF" 2>&1 | tail -15

echo "==> 设置 4 个 Secret ..."
ADMIN_PW=$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)
SESSION_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
TICKET_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
for kv in "ADMIN_PASSWORD:$ADMIN_PW" "SESSION_SECRET:$SESSION_SECRET" "TICKET_KEY:$TICKET_KEY"; do
  name=${kv%%:*}; val=${kv#*:}
  echo -n "$val" | "$NODE_BIN" "$WRANGLER" secret put "$name" --config "$WCONF" 2>&1 | tail -2
done
echo "ADMIN_PW=$ADMIN_PW" > E:/host_relay_adminpw.txt

echo
echo "部署完成!"
echo "  面板 (workers.dev): https://host-relay.cgq7139-41f.workers.dev"
echo "  面板 (自定义域)  : https://host-relay.hi315.us.ci"
echo "  管理员密码已存到: E:/host_relay_adminpw.txt  (请妥善保存, 勿外泄)"
