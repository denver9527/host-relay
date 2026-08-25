# host-relay

基于 Cloudflare Workers 免费额度的轻量主机管理面板。Agent 常驻上报状态,经 CF 反向中继(frp 模型)实现网页 SSH。当前为 **M1+M2**:状态上报 + 面板;网页 SSH 为 M3。

## 目录
```
worker.js        服务端(单文件:面板 + 逻辑 + Hub/Host 两个 DO)
wrangler.toml    首次部署配置
agent/           Go 客户端(main.go, go.mod)
```

## 一、部署服务端

首次必须用 wrangler(DO 需声明 migration);之后改代码可直接在 Dashboard 网页编辑器粘贴 worker.js。

```bash
cd host-relay
npx wrangler login
npx wrangler deploy           # 首次,创建 DO 命名空间
```

配置 Secret(Dashboard → Settings → Variables & Secrets,或命令):
```bash
npx wrangler secret put ADMIN_PASSWORD   # 面板登录密码(未设置则默认为 123456,部署后请立即在面板「修改密码」改掉)
npx wrangler secret put SESSION_SECRET   # 会话签名密钥,随机长字符串
npx wrangler secret put TICKET_KEY       # SSH ticket 签名密钥,随机长字符串
```

> 强烈建议绑定自定义域名(workers.dev 在国内常被污染)。绑定后用 `https://你的域名` 访问。
> 在 `worker.js` 顶部 `CLIENT_URL` 里改成你发布的客户端二进制地址。

## 二、构建客户端

```bash
cd agent
go mod tidy
# 本机构建
go build -o agent .
# 交叉编译(发布到 CLIENT_URL)
GOOS=linux   GOARCH=amd64 go build -o agent-linux-amd64 .
GOOS=darwin  GOARCH=arm64 go build -o agent-darwin-arm64 .
GOOS=windows GOARCH=amd64 go build -o agent-windows-amd64.exe .
```

## 三、添加并接入主机

1. 面板登录 → 点「添加主机」→ 填名称 → 生成。
2. 弹层给出各平台下载链接,以及可直接复制执行的命令:下载二进制、赋予执行权限(chmod 775)、安装到系统路径(/usr/local/bin/agent)、启动 agent(令牌只显示一次)。
3. 在目标主机执行启动命令:
   ```
   ./agent --server wss://你的域名 --id h_xxxx --token tk_xxxx
   ```
   无浏览器的机器可依次复制执行:下载 → chmod 775 → (可选)cp 到 /usr/local/bin → 启动。
4. agent 上线后,卡片自动出现并实时刷新 CPU / 内存 / 磁盘 / 运行时长。
5. 令牌丢失或要重置 → 卡片上「重新生成令牌」(旧令牌立即失效,会踢掉旧连接)。

## 四、网页 SSH

在线主机卡片上点「管理」→ 弹出独立终端窗口 → 填用户名 → 连接。
- agent 在目标主机**本地**以该用户名身份起 shell(agent 以 root 运行时通过 setuid 降权;用户名不存在则拒绝)。
- 终端基于 xterm.js,支持窗口自适应(resize)、多会话(可同时开多个终端窗口)。

数据流:浏览器 ⇄ Worker/Host DO(经 wss)⇄ agent ⇄ 本地 shell。agent 不连接任何 SSH 服务、不碰 PAM,权限边界在 relay 侧;终端字节在 CF 边缘/DO 内为明文(全程仍 TLS 到边缘)——homelab 自用的取舍。

## 行为说明
- 主机三态:`pending`(已生成未上线,不显示,24h 未上线自动清理)→ `active`(在线)→ `offline`(掉线后)。
- 状态经浏览器与 Hub DO 的 WS **推送**,非轮询;掉线 3s 自动重连。
- agent 用 WS 协议 ping 保活(免费),指数退避重连(发版会断开全部连接,靠重连恢复)。
- SSH ticket:面板点「管理」签发,有效期 5 分钟 + 一次性 nonce(Host DO 内防重放)。

## 免费额度
- WS 消息经 Worker 转发不计请求;DO 入站消息 20:1 计费;hibernation 期间不计 duration。
- 个人 homelab 规模稳在免费额度内。

## 五、在 CF 后台查看数据库数据
你可以直接在 Cloudflare Dashboard 中查看内置的 SQLite 数据：
1. Dashboard -> Workers & Pages -> Durable Objects，点击 `Hub` 或 `Host`，切换到 **Data / SQLite**。
2. 选择 **"Construct ID from string name"** (从名称构造 ID)。
3. 输入对应的 Name：
   - **查主机列表/登录记录**：选 `Hub`，Name 填入 **`_hub`**。
   - **查单台主机的加密凭据**：选 `Host`，Name 填入该主机的 `hostId` (例如 `h_1a2b3c4d5e`)。
4. 确认后即可在控制台执行 `SELECT * FROM hosts;` 等 SQL 语句查看数据。
