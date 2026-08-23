#!/usr/bin/env bash
# host-relay 部署脚本 —— 部署到 cld2 账户 (cgq7139@139.com), zone hi315.us.ci
#
# 前置条件:
#   1. 本机可直连 https://api.cloudflare.com (PUT/POST 不被出口代理拦截)
#   2. 已安装 curl 与 openssl
#   3. cld2.txt 含: 第2行=账户ID, 第5行=高权限api令牌(cfut_)
#
# 用法:
#   bash deploy-cf.sh [/path/to/cld2.txt]
#
# 说明:
#   - 脚本上传 worker.js (含 DO 绑定 HUB/HOST + migration v1)
#   - 自动生成并写入 4 个 Secret: ADMIN_PASSWORD(随机, 会回显) / SESSION_SECRET / TICKET_KEY / ENC_KEY
#   - 在 hi315.us.ci 建 DNS A 记录(host-relay) + Worker 路由
#   - workers.dev 子域 host-relay.cgq7139-41f.workers.dev 部署后自动可用, 无需 DNS
set -euo pipefail

C2="${1:-/e/cld2.txt}"
[ -f "$C2" ] || { echo "找不到 cld2.txt: $C2"; exit 1; }

TOKEN=$(sed -n '5p' "$C2" | tr -d '\r')
ACCT=$(sed -n '2p' "$C2" | tr -d '\r')

DIR="$(cd "$(dirname "$0")" && pwd)"
WS="$DIR/src/worker/worker.js"
META="$DIR/src/worker/deploy-metadata.json"
[ -f "$WS" ]  || { echo "找不到 $WS";   exit 1; }
[ -f "$META" ]|| { echo "找不到 $META"; exit 1; }

API="https://api.cloudflare.com/client/v4"
echo "==> 获取 zone hi315.us.ci ..."
ZONE=$(curl -s "$API/zones?name=hi315.us.ci" -H "Authorization: Bearer $TOKEN" \
  | grep -o '"id":"[a-f0-9]\{32\}"' | head -1 | cut -d'"' -f4)
[ -n "$ZONE" ] || { echo "zone 获取失败"; exit 1; }
echo "    zone = $ZONE"

echo "==> 上传 worker 脚本 (含 DO 绑定 + migration) ..."
curl -s -X PUT "$API/accounts/$ACCT/workers/scripts/host-relay" \
  -H "Authorization: Bearer $TOKEN" \
  -F "worker.js=@$WS;type=application/javascript" \
  -F "metadata=@$META;type=application/json" | head -c 400; echo

echo "==> 设置 4 个 Secret ..."
ADMIN_PW=$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 16)
for kv in "ADMIN_PASSWORD:$ADMIN_PW" \
         "SESSION_SECRET:$(openssl rand -base64 24 | tr -d '\n')" \
         "TICKET_KEY:$(openssl rand -base64 24 | tr -d '\n')" \
         "ENC_KEY:$(openssl rand -base64 24 | tr -d '\n')"; do
  name=${kv%%:*}; val=${kv#*:}
  curl -s -o /dev/null -w "    $name -> HTTP %{http_code}\n" \
    -X PUT "$API/accounts/$ACCT/workers/scripts/host-relay/secrets/$name" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"text\":\"$val\"}"
done

echo "==> 建 DNS A 记录 + Worker 路由 (host-relay.hi315.us.ci) ..."
curl -s -o /dev/null -w "    dns   -> HTTP %{http_code}\n" \
  -X POST "$API/zones/$ZONE/dns_records" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"A","name":"host-relay","content":"192.0.2.1","proxied":true,"ttl":1}'
curl -s -o /dev/null -w "    route -> HTTP %{http_code}\n" \
  -X POST "$API/zones/$ZONE/workers/routes" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"pattern":"host-relay.hi315.us.ci/*","script":"host-relay"}'

echo
echo "部署完成!"
echo "  面板 (workers.dev): https://host-relay.cgq7139-41f.workers.dev"
echo "  面板 (自定义域)  : https://host-relay.hi315.us.ci"
echo "  管理员密码 ADMIN_PASSWORD = $ADMIN_PW   <-- 请妥善保存"
