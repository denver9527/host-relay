// host-relay — Cloudflare Worker 主机管理面板(M1+M2:状态上报 + 网页面板)
// 单文件部署。首次用 wrangler(声明 DO migration),之后可在 Dashboard 粘贴本文件。
// 网页 SSH(M3)将在 Host DO 与面板中接入 ticket / xterm.js / channel 复用。

import { DurableObject } from 'cloudflare:workers';

// ============================ 配置 ============================
const VERSION = '1.0.6'; // 当前版本,CLIENT_URL 由此动态构建

// 各平台客户端下载地址(自行替换为你发布的二进制地址,不替换则可以用这个默认的)。
const CLIENT_URL = {
  linux: {
    "agent-linux-amd64": "https://github.com/denver9527/host-relay/releases/download/v" + VERSION + "/agent-linux-amd64",
    "agent-linux-arm64": "https://github.com/denver9527/host-relay/releases/download/v" + VERSION + "/agent-linux-arm64",
    "agent-linux-386": "https://github.com/denver9527/host-relay/releases/download/v" + VERSION + "/agent-linux-386",
    "agent-linux-arm": "https://github.com/denver9527/host-relay/releases/download/v" + VERSION + "/agent-linux-arm"
  },
  mac: {
    "agent-darwin-amd64": "https://github.com/denver9527/host-relay/releases/download/v" + VERSION + "/agent-darwin-amd64",
    "agent-darwin-arm64": "https://github.com/denver9527/host-relay/releases/download/v" + VERSION + "/agent-darwin-arm64"
  },
  win: {
    "agent-windows-amd64.exe": "https://github.com/denver9527/host-relay/releases/download/v" + VERSION + "/agent-windows-amd64.exe"
  }
};

const SESSION_TTL_MS   = 24 * 60 * 60 * 1000; // 会话有效期 24 小时(公共电脑风险更低, self-hosted 可接受)
const LOGIN_MAX_FAILS  = 5;                    // 连续失败次数上限
const LOGIN_LOCK_MS    = 10 * 60 * 1000;       // 锁定时长(10 分钟)
const LOGIN_WINDOW_MS  = 10 * 60 * 1000;       // 失败计数窗口:超过该时间未失败则重新计数
const PENDING_TTL_MS   = 24 * 60 * 60 * 1000;      // pending 主机未上线清理阈值
const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;       // 清理任务间隔
const TICKET_TTL_MS    = 5 * 60 * 1000;             // SSH ticket 有效期(5 分钟,避免开页久了点连接即失效)
const DEFAULT_ADMIN_PASSWORD = '123456';            // 未配置 ADMIN_PASSWORD secret 时的默认登录密码,部署后请立即在面板「修改密码」改掉
const HUB_NAME = '_hub';

// ============================ 工具函数 ============================
const enc = new TextEncoder();
const b64url = {
  enc(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return toHex(d);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// ---------- 面板密码(PBKDF2, 哈希存于 KV, 支持运行时修改) ----------
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iter = 100000;
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
  return 'pbkdf2$' + toHex(salt) + '$' + toHex(bits) + '$' + iter;
}
async function verifyPassword(pw, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('pbkdf2$')) return false;
  const [, saltHex, hashHex, iterS] = stored.split('$');
  let salt, iter;
  try { salt = hexToBytes(saltHex); iter = parseInt(iterS, 10) || 100000; } catch { return false; }
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
  return timingSafeEqual(toHex(bits), hashHex);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

async function signSession(secret, payloadObj) {
  const payload = b64url.enc(enc.encode(JSON.stringify(payloadObj)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return payload + '.' + b64url.enc(sig);
}

async function verifySession(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const key = await hmacKey(secret);
  const expected = b64url.enc(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(b64url.dec(payload)));
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj;
  } catch { return null; }
}

function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url.enc(a);
}

function randomHostId() {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return 'h_' + toHex(a);
}

function randomCid() {
  const a = new Uint8Array(2);
  crypto.getRandomValues(a);
  return ((a[0] << 8) | a[1]) || 1;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
}

async function isAuthed(req, env) {
  if (!env.SESSION_SECRET) return false;
  const c = parseCookies(req);
  return !!(await verifySession(env.SESSION_SECRET, c.session));
}

function hub(env) {
  return env.HUB.getByName(HUB_NAME);
}

function agentCommand(host, hostId, token) {
  return `agent --server wss://${host} --id ${hostId} --token ${token}`;
}

// ============================ Worker 入口 ============================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

    try {
      // ---- agent 长连接(无需会话,DO 内用 token 校验) ----
      if (path === '/ws/agent') {
        if (!upgrade) return new Response('expected websocket', { status: 426 });
        const id = url.searchParams.get('id');
        if (!id) return new Response('missing id', { status: 400 });
        return env.HOST.getByName(id).fetch(request);
      }

      // ---- 浏览器状态订阅(需会话) ----
      if (path === '/ws/status') {
        if (!upgrade) return new Response('expected websocket', { status: 426 });
        if (!(await isAuthed(request, env))) return new Response('unauthorized', { status: 401 });
        return hub(env).fetch(request);
      }

      // ---- 网页 SSH(用 ticket 鉴权,DO 内再次校验 nonce/归属) ----
      if (path === '/ws/ssh') {
        if (!upgrade) return new Response('expected websocket', { status: 426 });
        if (!env.TICKET_KEY) return new Response('ticket key not configured', { status: 500 });
        const ticket = url.searchParams.get('ticket');
        const obj = await verifySession(env.TICKET_KEY, ticket);
        if (!obj || !obj.h) return new Response('bad ticket', { status: 401 });
        return env.HOST.getByName(obj.h).fetch(request);
      }

      // ---- 页面 ----
      if (path === '/' && request.method === 'GET') {
        return new Response(PAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (path === '/term' && request.method === 'GET') {
        if (!(await isAuthed(request, env))) return new Response('unauthorized', { status: 401 });
        return new Response(TERM_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // ---- API ----
      if (path === '/api/ip' && request.method === 'GET') {
        return new Response(clientIp(request), { headers: { 'Content-Type': 'text/plain' } });
      }

      if (path === '/api/me' && request.method === 'GET') {
        return json({ authed: await isAuthed(request, env) });
      }

      if (path === '/api/clear-login-lock' && request.method === 'POST') {
        const ip = clientIp(request);
        const body = await request.json().catch(() => ({}));
        const pwInput = typeof body.password === 'string' ? body.password : '';
        const kvHash = env.RELAY_KV ? await env.RELAY_KV.get('admin:pwhash') : null;
        const pwOk = kvHash
          ? await verifyPassword(pwInput, kvHash)
          : timingSafeEqual(pwInput, env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
        if (!pwOk) {
          return json({ ok: false, error: '密码错误' }, { status: 401 });
        }
        await hub(env).loginReset(ip);
        return json({ ok: true });
      }

      if (path === '/api/login' && request.method === 'POST') {
        const ip = clientIp(request);
        const locked = await hub(env).loginLocked(ip);
        if (locked) return json({ ok: false, error: '尝试过于频繁,请稍后再试' }, { status: 429 });
        const body = await request.json().catch(() => ({}));
        if (!env.SESSION_SECRET) {
          return json({ ok: false, error: '服务端未配置 SESSION_SECRET' }, { status: 500 });
        }
        const pwInput = typeof body.password === 'string' ? body.password : '';
        // 优先用 KV 中已修改的密码哈希;未改过则回退到 ADMIN_PASSWORD secret,再回退默认密码
        const kvHash = env.RELAY_KV ? await env.RELAY_KV.get('admin:pwhash') : null;
        const pwOk = kvHash
          ? await verifyPassword(pwInput, kvHash)
          : timingSafeEqual(pwInput, env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
        if (pwOk) {
          await hub(env).loginReset(ip);
          const token = await signSession(env.SESSION_SECRET, { exp: Date.now() + SESSION_TTL_MS });
          return json({ ok: true }, {
            headers: {
              'Set-Cookie': `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
            },
          });
        }
        await hub(env).loginFail(ip);
        return json({ ok: false, error: '密码错误' }, { status: 401 });
      }

      if (path === '/api/logout' && request.method === 'POST') {
        return json({ ok: true }, {
          headers: { 'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' },
        });
      }

        // 以下接口均需会话
        if (path.startsWith('/api/')) {
          if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });

          if (path === '/api/hosts' && request.method === 'GET') {
            return json({ hosts: await hub(env).listHosts() });
          }

          // ---------- 回退密码(误操作 changepw 后恢复) ----------
          if (path === '/api/restorepw' && request.method === 'POST') {
            if (!env.RELAY_KV) return json({ error: '服务端未配置 KV 存储' }, { status: 500 });
            const oldHash = await env.RELAY_KV.get('admin:pwhash:old');
            if (!oldHash) return json({ error: '无可用回退密码' }, { status: 404 });
            await env.RELAY_KV.put('admin:pwhash', oldHash);
            // 清除回退备份
            try { await env.RELAY_KV.delete('admin:pwhash:old'); } catch {}
            return json({ ok: true, msg: '已恢复旧密码' });
          }

        if (path === '/api/enroll' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const name = (body.displayName || '').toString().slice(0, 64) || '未命名主机';
          const { hostId, token } = await hub(env).enroll(name);
          const serverUrl = (url.protocol === 'http:' ? 'ws://' : 'wss://') + url.host;
          return json({ hostId, token, command: agentCommand(url.host, hostId, token), serverUrl, clients: CLIENT_URL });
        }

        if (path === '/api/regenerate' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const r = await hub(env).regenerate((body.hostId || '').toString());
          if (!r) return json({ error: '主机不存在' }, { status: 404 });
          const serverUrl = (url.protocol === 'http:' ? 'ws://' : 'wss://') + url.host;
          return json({ token: r.token, command: agentCommand(url.host, r.hostId, r.token), serverUrl, clients: CLIENT_URL, hostId: r.hostId });
        }

        if (path === '/api/delete' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          await hub(env).deleteHost((body.hostId || '').toString());
          return json({ ok: true });
        }

        if (path === '/api/rename' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const updated = await hub(env).rename(
            (body.hostId || '').toString(),
            (body.displayName || '').toString()
          );
          if (!updated) return json({ error: '主机不存在或名称无效' }, { status: 400 });
          return json({ ok: true, host: updated });
        }

        if (path === '/api/ticket' && request.method === 'POST') {
          if (!env.TICKET_KEY) return json({ error: '服务端未配置 TICKET_KEY' }, { status: 500 });
          const body = await request.json().catch(() => ({}));
          const hostId = (body.hostId || '').toString();
          const ticket = await signSession(env.TICKET_KEY, {
            exp: Date.now() + TICKET_TTL_MS, h: hostId, n: randomToken(8),
          });
          return json({ ticket });
        }

        if (path === '/api/changepw' && request.method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const oldPw = typeof b.oldPassword === 'string' ? b.oldPassword : '';
          const newPw = typeof b.newPassword === 'string' ? b.newPassword : '';
          if (newPw.length < 6) return json({ error: '新密码至少 6 位' }, { status: 400 });
          const kvHash = env.RELAY_KV ? await env.RELAY_KV.get('admin:pwhash') : null;
          const oldOk = kvHash
            ? await verifyPassword(oldPw, kvHash)
            : timingSafeEqual(oldPw, env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
          if (!oldOk) return json({ error: '原密码错误' }, { status: 401 });
          // 回退保护:写入新 hash 前保存旧 hash 到 admin:pwhash:old,保留 24h 可回退
          if (kvHash) {
            await env.RELAY_KV.put('admin:pwhash:old', kvHash, { expirationTtl: 86400 });
          }
          await env.RELAY_KV.put('admin:pwhash', await hashPassword(newPw));
          return json({ ok: true });
        }

        // ---------- 云端备份(多副本) ----------
        if (path === '/api/backup' && request.method === 'POST') {
          if (!env.RELAY_KV) return json({ error: '服务端未配置 KV 存储' }, { status: 500 });
          const hosts = await hub(env).exportHosts();
          const payload = JSON.stringify({ version: 1, exportedAt: Date.now(), count: hosts.length, hosts });
          const id = await _bkSave(env, payload, hosts.length);
          return json({ ok: true, id, count: hosts.length });
        }

        if (path === '/api/backups' && request.method === 'GET') {
          if (!env.RELAY_KV) return json({ error: '服务端未配置 KV 存储' }, { status: 500 });
          return json({ backups: await _bkList(env) });
        }

        if (path === '/api/backup/delete' && request.method === 'POST') {
          if (!env.RELAY_KV) return json({ error: '服务端未配置 KV 存储' }, { status: 500 });
          const b = await request.json().catch(() => ({}));
          const id = (b.backupId || '').toString();
          if (!id) return json({ error: '缺少副本 ID' }, { status: 400 });
          await _bkDel(env, id);
          return json({ ok: true });
        }

        if (path === '/api/restore' && request.method === 'POST') {
          if (!env.RELAY_KV) return json({ error: '服务端未配置 KV 存储' }, { status: 500 });
          const b = await request.json().catch(() => ({}));
          const backupId = (b.backupId || '').toString();
          const raw = backupId ? await _bkGet(env, backupId) : await _bkGet(env, 'legacy');
          if (!raw) return json({ error: '云端没有可用的备份' }, { status: 404 });
          let data; try { data = JSON.parse(raw); } catch { return json({ error: '备份数据损坏' }, { status: 500 }); }
          if (data.version !== 1) return json({ error: '备份版本不兼容' }, { status: 400 });
          const n = await hub(env).importHosts(data.hosts || []);
          return json({ ok: true, count: n });
        }

        // ---------- 本地导入 / 导出 ----------
        if (path === '/api/export' && request.method === 'GET') {
          const hosts = await hub(env).exportHosts();
          return json({ version: 1, exportedAt: Date.now(), count: hosts.length, hosts });
        }

        if (path === '/api/import' && request.method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const hosts = Array.isArray(b.hosts) ? b.hosts : null;
          if (!hosts) return json({ error: '数据格式错误(缺少 hosts 数组)' }, { status: 400 });
          if (b.version && b.version !== 1) return json({ error: '备份版本不兼容' }, { status: 400 });
          const n = await hub(env).importHosts(hosts);
          return json({ ok: true, count: n });
        }
      }

      return new Response('not found', { status: 404 });
    } catch (e) {
      return json({ error: 'internal', detail: String(e && e.message || e) }, { status: 500 });
    }
  },
};

// ============================ 云端多副本备份 helpers ============================
// 旧版把整份备份塞进单一键 backup:hosts;新版本支持多副本:
//   backup:index        -> JSON 数组 [{id, exportedAt, count}] (副本清单,倒序)
//   backup:hosts:<id>   -> 单份备份 payload
//   backup:hosts        -> 遗留单副本(首次新备份时迁移为 backup:hosts:legacy 并删除)
const BK_INDEX = 'backup:index';
const BK_LEGACY = 'backup:hosts';
const BK_PREFIX = 'backup:hosts:';
const BK_MAX = 50; // 最多保留副本数,超出自动删最旧

async function _bkList(env) {
  if (!env.RELAY_KV) return [];
  let list = [];
  const raw = await env.RELAY_KV.get(BK_INDEX);
  if (raw) { try { list = JSON.parse(raw); } catch { list = []; } }
  // 兼容遗留单副本:若 index 为空但存在旧 backup:hosts,则合成为一条 legacy
  if (!list.length) {
    const legacy = await env.RELAY_KV.get(BK_LEGACY);
    if (legacy) { try { const d = JSON.parse(legacy); list = [{ id: 'legacy', exportedAt: d.exportedAt || 0, count: d.count || 0 }]; } catch {} }
  }
  list.sort((a, b) => (b.exportedAt || 0) - (a.exportedAt || 0));
  return list;
}
async function _bkSave(env, payload, count) {
  if (!env.RELAY_KV) return null;
  const id = 'b' + Date.now().toString(36) + randomToken(4);
  await env.RELAY_KV.put(BK_PREFIX + id, payload);
  let list = [];
  const raw = await env.RELAY_KV.get(BK_INDEX);
  if (raw) { try { list = JSON.parse(raw); } catch { list = []; } }
  // 迁移遗留单副本:把旧 backup:hosts 转存为 backup:hosts:legacy 并进入 index
  const legacy = await env.RELAY_KV.get(BK_LEGACY);
  if (legacy) { try {
    const d = JSON.parse(legacy);
    await env.RELAY_KV.put(BK_PREFIX + 'legacy', legacy);
    list.push({ id: 'legacy', exportedAt: d.exportedAt || 0, count: d.count || 0 });
    await env.RELAY_KV.delete(BK_LEGACY);
  } catch {} }
  list.push({ id, exportedAt: Date.now(), count });
  list.sort((a, b) => (a.exportedAt || 0) - (b.exportedAt || 0));
  while (list.length > BK_MAX) { const old = list.shift(); try { await env.RELAY_KV.delete(BK_PREFIX + old.id); } catch {} }
  await env.RELAY_KV.put(BK_INDEX, JSON.stringify(list));
  return id;
}
async function _bkGet(env, id) {
  if (!env.RELAY_KV) return null;
  if (id === 'legacy') return (await env.RELAY_KV.get(BK_LEGACY)) || (await env.RELAY_KV.get(BK_PREFIX + 'legacy'));
  return await env.RELAY_KV.get(BK_PREFIX + id);
}
async function _bkDel(env, id) {
  if (!env.RELAY_KV) return false;
  if (id === 'legacy') {
    try { await env.RELAY_KV.delete(BK_LEGACY); } catch {}
    try { await env.RELAY_KV.delete(BK_PREFIX + 'legacy'); } catch {}
  } else {
    try { await env.RELAY_KV.delete(BK_PREFIX + id); } catch {}
  }
  let list = [];
  const raw = await env.RELAY_KV.get(BK_INDEX);
  if (raw) { try { list = JSON.parse(raw); } catch { list = []; } }
  list = list.filter(x => x.id !== id);
  await env.RELAY_KV.put(BK_INDEX, JSON.stringify(list));
  return true;
}

// ============================ Hub DO(单例) ============================
// 主机注册表 + 状态快照 + 浏览器订阅广播 + 登录防爆破 + pending 清理。
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS hosts(
      hostId TEXT PRIMARY KEY,
      displayName TEXT,
      os TEXT,
      tokenHash TEXT,
      state TEXT,
      lastSeen INTEGER,
      statusJson TEXT,
      createdAt INTEGER
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS login_attempts(
      ip TEXT PRIMARY KEY, fails INTEGER, lockUntil INTEGER
    )`);
  }

  // ---------- 浏览器订阅 WS ----------
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['sub']);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // 连接即推送全量快照
    server.send(JSON.stringify({ type: 'snapshot', hosts: this._hostList() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    // 浏览器侧目前仅需接收;预留处理(忽略)。
  }
  async webSocketClose(ws) {}
  async webSocketError(ws) {}

  _broadcastHost(hostId) {
    const h = this._getHost(hostId);
    if (!h) return;
    const data = JSON.stringify({ type: 'host', host: this._view(h) });
    for (const ws of this.ctx.getWebSockets('sub')) {
      try { ws.send(data); } catch {}
    }
  }
  _broadcastRemove(hostId) {
    const data = JSON.stringify({ type: 'remove', hostId });
    for (const ws of this.ctx.getWebSockets('sub')) {
      try { ws.send(data); } catch {}
    }
  }

  // ---------- 视图(对外不暴露 tokenHash) ----------
  _view(h) {
    let status = null;
    try { status = h.statusJson ? JSON.parse(h.statusJson) : null; } catch {}
    return {
      hostId: h.hostId, displayName: h.displayName, os: h.os,
      state: h.state, lastSeen: h.lastSeen, status,
    };
  }
  _getHost(hostId) {
    const c = this.sql.exec('SELECT * FROM hosts WHERE hostId = ?', hostId).toArray();
    return c[0] || null;
  }
  _hostList() {
    // 面板只显示 active / offline(pending 不显示)
    return this.sql.exec(
      "SELECT * FROM hosts WHERE state IN ('active','offline') ORDER BY displayName"
    ).toArray().map((h) => this._view(h));
  }

  // ---------- 注册 / 令牌 ----------
  async enroll(displayName) {
    const hostId = randomHostId();
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO hosts(hostId, displayName, os, tokenHash, state, lastSeen, statusJson, createdAt) VALUES(?,?,?,?,?,?,?,?)',
      hostId, displayName, '', tokenHash, 'pending', 0, null, now,
    );
    await this.env.HOST.getByName(hostId).provision(hostId, tokenHash);
    await this._ensureAlarm();
    return { hostId, token };
  }

  async regenerate(hostId) {
    const h = this._getHost(hostId);
    if (!h) return null;
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    this.sql.exec('UPDATE hosts SET tokenHash = ? WHERE hostId = ?', tokenHash, hostId);
    // 作废旧 token:更新 Host DO 并踢掉当前 agent(若在线),迫使用新 token 重连
    await this.env.HOST.getByName(hostId).resetToken(tokenHash);
    // 广播 token 已更新(虽卡片不显示 token,但为将来扩展预留)
    this._broadcastHost(hostId);
    return { hostId, token };
  }

  async rename(hostId, displayName) {
    const h = this._getHost(hostId);
    if (!h) return null;
    const name = (displayName || '').toString().trim().slice(0, 64);
    if (!name) return null;
    this.sql.exec('UPDATE hosts SET displayName = ? WHERE hostId = ?', name, hostId);
    this._broadcastHost(hostId);
    return this._view({ ...h, displayName: name });
  }

  async deleteHost(hostId) {
    this.sql.exec('DELETE FROM hosts WHERE hostId = ?', hostId);
    try { await this.env.HOST.getByName(hostId).deprovision(); } catch {}
    this._broadcastRemove(hostId);
  }

  async listHosts() { return this._hostList(); }

  // ---------- 备份 / 恢复(云端 KV) ----------
  async exportHosts() {
    // 只导出已接入/离线的主机,pending(未连上 agent 的临时态)不进备份,
    // 避免恢复时把 pending 误变成 offline 卡片。
    return this.sql.exec(
      "SELECT hostId, displayName, os, tokenHash, state, statusJson, createdAt FROM hosts WHERE state IN ('active','offline')"
    ).toArray();
  }
  async importHosts(list) {
    let n = 0;
    for (const h of (list || [])) {
      if (!h || !h.hostId) continue;
      this.sql.exec(
        `INSERT INTO hosts(hostId, displayName, os, tokenHash, state, lastSeen, statusJson, createdAt)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(hostId) DO UPDATE SET
           displayName=excluded.displayName, os=excluded.os, tokenHash=excluded.tokenHash,
           state=excluded.state, statusJson=excluded.statusJson, createdAt=excluded.createdAt`,
        h.hostId, h.displayName || '', h.os || '', h.tokenHash || '', h.state || 'offline', 0,
        h.statusJson || null, h.createdAt || Date.now());
      // 还原令牌到 Host DO,使已连 agent 用原 token 继续工作(恢复后旧 token 仍可用,无需重新生成)
      try { await this.env.HOST.getByName(h.hostId).provision(h.hostId, h.tokenHash); } catch {}
      n++;
    }
    await this._ensureAlarm();
    const snap = JSON.stringify({ type: 'snapshot', hosts: this._hostList() });
    for (const ws of this.ctx.getWebSockets('sub')) { try { ws.send(snap); } catch {} }
    return n;
  }

  // ---------- 由 Host DO 回调 ----------
  async activate(hostId, os) {
    const h = this._getHost(hostId);
    if (!h) return;
    this.sql.exec('UPDATE hosts SET state = ?, os = ?, lastSeen = ? WHERE hostId = ?',
      'active', os || h.os || '', Date.now(), hostId);
    this._broadcastHost(hostId);
  }

  async updateStatus(hostId, statusJson) {
    const h = this._getHost(hostId);
    if (!h) return;
    const os = (() => { try { return JSON.parse(statusJson).platform || h.os; } catch { return h.os; } })();
    this.sql.exec('UPDATE hosts SET state = ?, statusJson = ?, lastSeen = ?, os = ? WHERE hostId = ?',
      'active', statusJson, Date.now(), os, hostId);
    this._broadcastHost(hostId);
  }

  async markOffline(hostId) {
    const h = this._getHost(hostId);
    if (!h || h.state === 'pending') return;
    this.sql.exec('UPDATE hosts SET state = ?, lastSeen = ? WHERE hostId = ?', 'offline', Date.now(), hostId);
    this._broadcastHost(hostId);
  }

  // ---------- 登录防爆破 ----------
  async loginLocked(ip) {
    const r = this.sql.exec('SELECT lockUntil FROM login_attempts WHERE ip = ?', ip).toArray()[0];
    return !!(r && r.lockUntil && r.lockUntil > Date.now());
  }
  async loginFail(ip) {
    const now = Date.now();
    const r = this.sql.exec('SELECT fails, lockUntil FROM login_attempts WHERE ip = ?', ip).toArray()[0];
    // 如果上一条锁定已过期, 重新计数; 避免一次错误永久累计
    const stale = !r || (r.lockUntil && r.lockUntil <= now);
    const fails = stale ? 1 : (r.fails || 0) + 1;
    const lockUntil = fails >= LOGIN_MAX_FAILS ? now + LOGIN_LOCK_MS : 0;
    this.sql.exec('INSERT INTO login_attempts(ip, fails, lockUntil) VALUES(?,?,?) ' +
      'ON CONFLICT(ip) DO UPDATE SET fails = ?, lockUntil = ?', ip, fails, lockUntil, fails, lockUntil);
  }
  async loginReset(ip) { this.sql.exec('DELETE FROM login_attempts WHERE ip = ?', ip); }

  // ---------- pending 清理 ----------
  async _ensureAlarm() {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_EVERY_MS);
  }
  async alarm() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    const stale = this.sql.exec(
      "SELECT hostId FROM hosts WHERE state = 'pending' AND createdAt < ?", cutoff
    ).toArray();
    for (const row of stale) {
      this.sql.exec('DELETE FROM hosts WHERE hostId = ?', row.hostId);
      try { await this.env.HOST.getByName(row.hostId).deprovision(); } catch {}
      // 通知浏览器侧 pending 已被清理(避免外部消费者看到旧状态)
      this._broadcastRemove(row.hostId);
    }
    const remain = this.sql.exec('SELECT COUNT(*) AS n FROM hosts').toArray()[0];
    if (remain && remain.n > 0) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_EVERY_MS);
  }
}

// ============================ Host DO(每主机一个) ============================
// 持有该主机 agent 长连接;令牌校验;状态转发 Hub;首次上线激活。
// 网页 SSH(M3)将在此 DO 内复用 channelId 转发终端字节。
export class Host extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this._sshOpenTimers = {};
  }

  // 由 Hub 在 enroll 时种入身份
  async provision(hostId, tokenHash) {
    await this.ctx.storage.put('hostId', hostId);
    await this.ctx.storage.put('tokenHash', tokenHash);
  }
  async resetToken(tokenHash) {
    await this.ctx.storage.put('tokenHash', tokenHash);
    // 踢掉当前 agent(旧 token 已失效)
    for (const ws of this.ctx.getWebSockets('agent')) {
      try { ws.close(4001, 'token rotated'); } catch {}
    }
  }
  async deprovision() {
    for (const ws of this.ctx.getWebSockets('agent')) {
      try { ws.close(4002, 'host removed'); } catch {}
    }
    await this.ctx.storage.deleteAll();
  }

  // WS 接入:agent(/ws/agent)或 网页终端(/ws/ssh)
  async fetch(request) {
    const url = new URL(request.url);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    if (url.pathname === '/ws/ssh') {
      if (!this.env.TICKET_KEY) return new Response('ticket key not configured', { status: 500 });
      const ticket = url.searchParams.get('ticket');
      const obj = await verifySession(this.env.TICKET_KEY, ticket);
      const myId = await this.ctx.storage.get('hostId');
      if (!obj || obj.h !== myId) return new Response('bad ticket', { status: 401 });
      const nkey = 'nonce:' + obj.n;
      if (await this.ctx.storage.get(nkey)) return new Response('ticket replay', { status: 401 });
      // 一次性:写入后该 nonce 即失效;附带过期,避免 DO 存储无限增长
      const nonceTtl = Math.max(120, Math.ceil((obj.exp - Date.now()) / 1000) + 120);
      await this.ctx.storage.put(nkey, obj.exp, { expirationTtl: nonceTtl });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ role: 'browser', cid: await this._allocCid() });
      this.ctx.acceptWebSocket(server, ['browser']);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 默认:agent 长连接
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['agent']);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'browser') return this._fromBrowser(ws, att, raw);
    return this._fromAgent(ws, att, raw);
  }

  // ---------- agent 侧 ----------
  async _fromAgent(ws, att, raw) {
    if (typeof raw !== 'string') {
      // [0x01][cid:2][stdout] → 转发对应 browser
      const u = new Uint8Array(raw);
      if (u[0] !== 1 || u.length < 3) return;
      const cid = (u[1] << 8) | u[2];
      const b = this._browserByCid(cid);
      if (b) { try { b.send(u.subarray(3)); } catch {} }
      return;
    }
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      const storedHash = await this.ctx.storage.get('tokenHash');
      const hostId = await this.ctx.storage.get('hostId');
      const ok = storedHash && hostId && typeof msg.token === 'string'
        && timingSafeEqual(await sha256Hex(msg.token), storedHash);
      if (!ok) {
        try { ws.send(JSON.stringify({ type: 'error', msg: '令牌无效' })); } catch {}
        try { ws.close(4003, 'invalid token'); } catch {}
        return;
      }
      ws.serializeAttachment({ authed: true, hostId });
      const os = msg.os ? (msg.os + (msg.arch ? '/' + msg.arch : '')) : '';
      await this.env.HUB.getByName(HUB_NAME).activate(hostId, os);
      try { ws.send(JSON.stringify({ type: 'registered' })); } catch {}
      return;
    }

    if (!att.authed) { try { ws.close(4003, 'not registered'); } catch {} return; }

    if (msg.type === 'status') {
      await this.env.HUB.getByName(HUB_NAME).updateStatus(att.hostId, JSON.stringify(msg));
      return;
    }
    if (msg.type === 'ssh_opened' || msg.type === 'ssh_error' || msg.type === 'ssh_close') {
      const cid = msg.channelId;
      if (this._sshOpenTimers[cid]) { clearTimeout(this._sshOpenTimers[cid]); delete this._sshOpenTimers[cid]; }
      const b = this._browserByCid(cid);
      if (b) {
        try { b.send(JSON.stringify({ type: msg.type, msg: msg.msg })); } catch {}
        // 不再主动 close 浏览器 WS;关闭由 webSocketClose(浏览器自身 onclose)统一处理,
        // 避免 agent 正常起 shell 后 worker 抢关导致页面秒显"会话已结束"。
      }
      return;
    }
  }

  // ---------- browser 侧 ----------
  async _fromBrowser(ws, att, raw) {
    const agent = this._agentWs();
    if (typeof raw !== 'string') {
      // stdin 字节 → [0x01][cid][payload] → agent
      if (!agent) return;
      const payload = new Uint8Array(raw);
      const f = new Uint8Array(3 + payload.length);
      f[0] = 1; f[1] = (att.cid >> 8) & 255; f[2] = att.cid & 255; f.set(payload, 3);
      try { agent.send(f); } catch {}
      return;
    }
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth') {
      if (!agent) { this._sendBrowser(ws, { type: 'ssh_error', msg: '主机离线,无法连接' }); try { ws.close(); } catch {} return; }
      // 幂等:同一 cid 已有进行中的 ssh_open(定时器在跑)则忽略重复 auth,避免重复 open 覆盖 channel 造成孤儿 shell
      if (this._sshOpenTimers[att.cid]) return;
      // 方案 B:relay 已鉴权,agent 直接以 username 起本地 shell(或经 sshd 起真终端)。
      // shell: powershell/cmd/ssh(空等同按 OS 默认); SSH 模式带 credential(密码)做 SSH 登录。
      try {
        agent.send(JSON.stringify({
          type: 'ssh_open', channelId: att.cid,
          username: msg.username || '',
          shell: msg.shell || '',
          authType: msg.authType || (msg.shell === 'ssh' ? 'password' : ''),
          credential: msg.credential || '',
          cols: msg.cols || 80, rows: msg.rows || 24,
        }));
      } catch {}
      // 超时兜底:15s 内未收到该 channel 的 ssh_opened/ssh_error 则主动报错,消除"永久转圈"
      const cid = att.cid;
      clearTimeout(this._sshOpenTimers[cid]);
      this._sshOpenTimers[cid] = setTimeout(() => {
        const b = this._browserByCid(cid);
        if (b) {
          try { b.send(JSON.stringify({ type: 'ssh_error', msg: '连接超时,请检查目标主机是否就绪后重试' })); } catch {}
          // 不主动 close 浏览器 WS;让浏览器自行处理或走 webSocketClose,避免误杀已建立的 shell 会话。
        }
        delete this._sshOpenTimers[cid];
      }, 15000);
      return;
    }
    if (msg.type === 'resize' && agent) {
      try { agent.send(JSON.stringify({ type: 'resize', channelId: att.cid, cols: msg.cols, rows: msg.rows })); } catch {}
      return;
    }
  }

  _agentWs() {
    for (const ws of this.ctx.getWebSockets('agent')) {
      const a = ws.deserializeAttachment();
      if (a && a.authed) return ws;
    }
    return null;
  }
  _browserByCid(cid) {
    for (const ws of this.ctx.getWebSockets('browser')) {
      const a = ws.deserializeAttachment();
      if (a && a.cid === cid) return ws;
    }
    return null;
  }
  // 分配一个当前未被活跃 browser 占用的 cid。协议层 cid 为 uint16(agent 侧截断),
  // 故在 1..65535 空间内做拒绝采样:若随机到的 cid 已被某终端会话使用则重生成,
  // 把运行时串台概率降到≈0(并发会话数远小于空间大小,采样几乎一次命中)。
  async _allocCid() {
    for (let i = 0; i < 64; i++) {
      const c = randomCid();
      if (!this._browserByCid(c)) return c;
    }
    // 极端兜底:直接返回(理论上并发会话接近 65535 才会走到)
    return randomCid();
  }
  _sendBrowser(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'browser') {
      if (this._sshOpenTimers[att.cid]) { clearTimeout(this._sshOpenTimers[att.cid]); delete this._sshOpenTimers[att.cid]; }
      const agent = this._agentWs();
      if (agent) { try { agent.send(JSON.stringify({ type: 'ssh_close', channelId: att.cid })); } catch {} }
      return;
    }
    if (att.authed && att.hostId) {
      try { await this.env.HUB.getByName(HUB_NAME).markOffline(att.hostId); } catch {}
      for (const b of this.ctx.getWebSockets('browser')) {
        try { b.send(JSON.stringify({ type: 'ssh_close', msg: '主机连接已断开' })); } catch {}
        try { b.close(1000, 'agent gone'); } catch {}
      }
    }
  }
  async webSocketError(ws) {}
}

// ============================ 内联面板(HTML/CSS/JS) ============================
// 设计:控制室风格,深色 slate 底,等宽字体呈现数据,青色信号色 + 琥珀/红表示离线告警。
// 纯系统字体,无 CDN 依赖,便于国内访问。客户端 JS 避免使用反引号模板。
const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>host-relay</title>
<style>
  :root{
    --bg:#0e1116; --panel:#161b22; --panel-2:#1c232d; --line:#2a3441;
    --txt:#d6dee8; --muted:#7d8a9c; --signal:#3fd6c8; --signal-dim:#1f5e58;
    --amber:#e0a341; --red:#e05a5a; --green:#3fd67a;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font-family:var(--sans);
    -webkit-font-smoothing:antialiased;line-height:1.5}
  a{color:var(--signal)}
  .wrap{max-width:1100px;margin:0 auto;padding:24px 20px 64px}
  header{display:flex;align-items:center;justify-content:space-between;
    padding:18px 0;border-bottom:1px solid var(--line);margin-bottom:24px}
  .brand{font-family:var(--mono);font-size:18px;letter-spacing:.5px}
  .brand b{color:var(--signal)}
  .brand .tag{color:var(--muted);font-size:12px;margin-left:10px}
  button{font-family:var(--sans);cursor:pointer;border-radius:8px;border:1px solid var(--line);
    background:var(--panel-2);color:var(--txt);padding:8px 14px;font-size:14px}
  button:hover{border-color:var(--signal-dim)}
  button.primary{background:var(--signal);color:#06231f;border-color:var(--signal);font-weight:600}
  button.primary:hover{filter:brightness(1.08)}
  button.ghost{background:transparent}
  button.danger:hover{border-color:var(--red);color:var(--red)}
  button:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
  .toolbar{display:flex;gap:10px;align-items:center}
  .menu-wrap{position:relative}
  .caret{font-size:10px;margin-left:4px;opacity:.7;display:inline-block;transition:transform .2s}
  .menu-wrap.open .caret{transform:rotate(180deg)}
  .menu{position:absolute;top:calc(100% + 8px);right:0;min-width:180px;background:var(--panel);
    border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.45);
    padding:6px;display:none;z-index:50}
  .menu-wrap.open .menu{display:block}
  .menu-item{display:block;width:100%;text-align:left;padding:9px 12px;border:0;
    background:transparent;color:var(--txt);font-size:14px;border-radius:6px;cursor:pointer;font-family:inherit}
  .menu-item:hover{background:var(--panel-2);color:var(--signal)}
  .menu-sep{height:1px;background:var(--line);margin:5px 4px}

  /* 登录 */
  .login{max-width:360px;margin:14vh auto 0;padding:28px;background:var(--panel);
    border:1px solid var(--line);border-radius:14px}
  .login h1{font-family:var(--mono);font-size:20px;margin:0 0 4px}
  .login p{color:var(--muted);font-size:13px;margin:0 0 20px}
  .field{display:block;margin-bottom:14px}
  .field input{width:100%;padding:11px 12px;border-radius:8px;border:1px solid var(--line);
    background:var(--bg);color:var(--txt);font-family:var(--mono);font-size:14px}
  .field input:focus{outline:none;border-color:var(--signal)}
  .err{color:var(--red);font-size:13px;min-height:18px;margin:-4px 0 10px}

  /* 卡片 */
  .grid{display:flex;flex-wrap:wrap;gap:16px}
  .grid > .card{flex:0 0 calc((100% - 32px) / 3);max-width:calc((100% - 32px) / 3);min-width:0;overflow:hidden}
  @media(max-width:1100px){.grid > .card{flex:0 0 calc((100% - 16px) / 2);max-width:calc((100% - 16px) / 2)}}
  @media(max-width:640px){.grid > .card{flex:0 0 100%;max-width:100%}}
  .empty{color:var(--muted);text-align:center;padding:60px 0;font-size:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 16px 14px;
    position:relative;overflow:hidden}
  .card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--line)}
  .card.online::before{background:var(--signal)}
  .card.offline::before{background:var(--muted)}
  .card .name{font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px}
  .card .name.editable{cursor:pointer;border-radius:4px;padding:1px 4px;margin:-1px -4px;transition:background .15s}
  .card .name.editable:hover{background:var(--panel-2)}
  .card .name.editable .edit-icon{opacity:.28;transition:opacity .15s;color:var(--muted);width:12px;height:12px;flex:none;margin-left:2px}
  .card .name.editable:hover .edit-icon{opacity:.75}
  .card .name .nm-input{font:inherit;font-weight:600;color:inherit;background:var(--panel-2);border:1px solid var(--line);border-radius:4px;padding:1px 5px;outline:none;min-width:60px;max-width:100%}
  .card .name .nm-input:focus{border-color:var(--signal)}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex:none}
  .card.online .dot{background:var(--green);box-shadow:0 0 0 0 rgba(63,214,122,.6);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(63,214,122,.5)}70%{box-shadow:0 0 0 6px rgba(63,214,122,0)}100%{box-shadow:0 0 0 0 rgba(63,214,122,0)}}
  @media (prefers-reduced-motion:reduce){.card.online .dot{animation:none}}
  .card .meta{font-family:var(--mono);font-size:11px;color:var(--muted);margin:3px 0 14px}
  .metric{margin:10px 0}
  .metric .lbl{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px}
  .metric .lbl b{color:var(--txt);font-family:var(--mono);font-weight:500}
  .bar{height:6px;border-radius:4px;background:var(--panel-2);overflow:hidden}
  .bar i{display:block;height:100%;background:var(--signal);border-radius:4px;transition:width .4s}
  .bar.warn i{background:var(--amber)} .bar.crit i{background:var(--red)}
  .card .foot{display:flex;justify-content:space-between;align-items:center;margin-top:14px;
    padding-top:12px;border-top:1px solid var(--line)}
  .card .foot .when{font-size:11px;color:var(--muted);font-family:var(--mono)}
  .card .foot .acts{display:flex;gap:6px}
  .card .foot button{padding:5px 9px;font-size:12px}
  .offnote{color:var(--muted);font-size:12px;padding:8px 0}
  .ips{font-size:11px;font-family:var(--mono);color:var(--muted);margin:8px 0 0 0;}
  .ips .pub{display:inline-flex;align-items:center;cursor:pointer;padding:2px 6px;background:var(--panel-2);border-radius:4px;}
  .ips .pub:hover{color:var(--txt);}
  .ips .pub svg{width:10px;height:10px;margin-left:4px;transition:transform .2s;}
  .card.open-ips .ips .pub svg{transform:rotate(180deg);}
  .ips .locals{display:none;margin-top:6px;padding-left:4px;border-left:2px solid var(--line);}
  .card.open-ips .ips .locals{display:block;}
  .ips .locals div{margin-bottom:2px;}

  /* 弹层 */
  .mask{position:fixed;inset:0;background:rgba(5,8,12,.7);display:flex;align-items:flex-start;
    justify-content:center;padding:8vh 16px;z-index:50}
  .modal{width:560px;max-width:100%;background:var(--panel);border:1px solid var(--line);
    border-radius:14px;padding:22px}
  .modal h2{font-family:var(--mono);font-size:17px;margin:0 0 16px;display:flex;justify-content:space-between}
  .modal h2 .x{cursor:pointer;color:var(--muted)}
  .step{margin-bottom:18px}
  .step .h{font-size:13px;color:var(--muted);margin-bottom:8px}
  .dl a{display:block;font-family:var(--mono);font-size:13px;padding:9px 12px;border:1px solid var(--line);
    border-radius:8px;margin-bottom:7px;text-decoration:none;color:var(--txt);word-break:break-all}
  .dl a:hover{border-color:var(--signal-dim)}
  .dl a span{color:var(--muted);margin-right:8px}
  .cmd{position:relative}
  .cmd pre{font-family:var(--mono);font-size:12.5px;background:var(--bg);border:1px solid var(--line);
    border-radius:8px;padding:14px 14px;margin:0;white-space:pre-wrap;word-break:break-all;color:var(--signal)}
  .cmd .copy{position:absolute;top:8px;right:8px;padding:4px 10px;font-size:12px}
  .hint{font-size:12px;color:var(--amber);margin-top:10px}
  
  .tags{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;}
  .tag-btn{padding:6px 12px;font-size:13px;background:var(--panel-2);border:1px solid var(--line);border-radius:20px;color:var(--txt);cursor:pointer;transition:all 0.2s;font-family:var(--mono);}
  .tag-btn:hover{background:var(--line);}
  .tag-btn.active{background:var(--signal);color:var(--bg);border-color:var(--signal);font-weight:600;}
  .tab-content{display:none;}
  .tab-content.active{display:block;}
  .dl-btn{display:inline-block;margin-bottom:12px;padding:8px 16px;background:var(--panel-2);color:var(--txt);text-decoration:none;border-radius:6px;font-size:13px;transition:all 0.2s;border:1px solid var(--line);}
  .dl-btn:hover{background:var(--line);border-color:var(--signal-dim);}
  
  .row-name{display:flex;gap:8px;margin-bottom:14px}
  .row-name input{flex:1;padding:10px 12px;border-radius:8px;border:1px solid var(--line);
    background:var(--bg);color:var(--txt);font-size:14px}
  .row-name input:focus{outline:none;border-color:var(--signal)}
  .pw-wrap{flex:1;position:relative;width:100%;box-sizing:border-box}
  .pw-wrap input{width:100%;padding:10px 38px 10px 12px;border-radius:8px;border:1px solid var(--line);
    background:var(--bg);color:var(--txt);font-size:14px;box-sizing:border-box}
  .pw-wrap input:focus{outline:none;border-color:var(--signal)}
  .pw-toggle{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:transparent;border:none;
    color:var(--muted);cursor:pointer;padding:4px;display:flex;align-items:center;justify-content:center;border-radius:4px}
  .pw-toggle:hover{color:var(--txt);background:var(--line)}
  .pw-toggle svg{display:block}
  .box .pw-wrap input{border-color:#2a3441;background:#0e1116;color:#d6dee8;padding:10px 38px 10px 10px}
  .box .pw-wrap input:focus{border-color:#3fd6c8}
</style>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
var app = document.getElementById("app");
var ws = null;
var hosts = {};
var uiState = { openIps: {} }; // 记录哪些主机的 IP 是展开状态的

function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c] || c; }); }
function fmtBytes(n){ if(!n&&n!==0) return "-"; var u=["B","KB","MB","GB","TB"],i=0;
  while(n>=1024&&i<u.length-1){n/=1024;i++;} return n.toFixed(n<10&&i>0?1:0)+u[i]; }
function fmtUptime(s){ if(!s) return "-"; s=Math.floor(s); var d=Math.floor(s/86400);
  var h=Math.floor((s%86400)/3600); var m=Math.floor((s%3600)/60);
  if(d>0) return d+"d "+h+"h"; if(h>0) return h+"h "+m+"m"; return m+"m"; }
function ago(ts){ if(!ts) return "从未"; var s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return s+"s 前"; if(s<3600) return Math.floor(s/60)+"m 前";
  if(s<86400) return Math.floor(s/3600)+"h 前"; return Math.floor(s/86400)+"d 前"; }

function api(path, body){
  return fetch(path, {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body||{})}).then(function(r){ return r.json().then(function(j){
      return {status:r.status, body:j}; }); }).catch(function(e){ return {status:500, body:{error:String(e)}}; });
}

// ---------------- 登录 ----------------
function renderLogin(errMsg){
  app.innerHTML =
    '<div class="login"><h1>host-relay</h1>'+
    '<p>主机管理面板 · 请登录</p>'+
    '<div class="field"><input id="pw" type="password" placeholder="密码" autofocus></div>'+
    '<div class="err" id="le">'+esc(errMsg||"")+'</div>'+
    '<button class="primary" id="lb" style="width:100%">登录</button>'+
    '<button class="ghost" id="cl" style="width:100%;margin-top:8px;display:none">清除登录锁定</button></div>';
  var pw=document.getElementById("pw"), lb=document.getElementById("lb"), cl=document.getElementById("cl");
  function go(){ lb.disabled=true;
    api("/api/login",{password:pw.value}).then(function(r){
      if(r.body.ok){ boot(); } else { lb.disabled=false;
        document.getElementById("le").textContent=r.body.error||"登录失败";
        // 被锁定时显示「清除锁定」按钮
        if(r.status === 429 || (r.body.error && r.body.error.indexOf('频繁')>=0)){
          cl.style.display='block';
        }
        pw.focus(); } });
  }
  lb.onclick=go; pw.onkeydown=function(e){ if(e.key==="Enter") go(); };
  cl.onclick=function(){
    cl.disabled=true;
    api("/api/clear-login-lock",{password:pw.value}).then(function(r){
      if(r.body.ok){ cl.style.display='none'; document.getElementById("le").textContent="已清除,请重新登录"; go(); }
      else { cl.disabled=false; document.getElementById("le").textContent=r.body.error||"清除失败"; pw.focus(); }
    });
  };
}

// ---------------- 主面板 ----------------
function renderApp(){
  app.innerHTML =
    '<div class="wrap"><header>'+
    '<div class="brand"><b>host</b>-relay<span class="tag">主机管理面板</span></div>'+
    '<div class="toolbar">'+
    '<button class="primary" id="add">添加主机</button>'+
    '<div class="menu-wrap" id="sysmenu-wrap">'+
      '<button class="ghost" id="sysmenu-btn">系统功能 <span class="caret">▾</span></button>'+
      '<div class="menu" id="sysmenu">'+
        '<button class="menu-item" data-act="chpw">修改密码</button>'+
        '<button class="menu-item" data-act="backup">备份云端</button>'+
        '<button class="menu-item" data-act="restore">从云端恢复</button>'+
        '<div class="menu-sep"></div>'+
        '<button class="menu-item" data-act="export">导出本地</button>'+
        '<button class="menu-item" data-act="import">导入本地</button>'+
      '</div>'+
    '</div>'+
    '<button class="ghost" id="logout">退出</button>'+
    '</div></header><div id="list"></div></div>';
  document.getElementById("add").onclick=openAdd;
  // 下拉菜单:点击切换、外部点击关闭、Esc 关闭(全局只绑一次,避免 renderApp 重复触发)
  var sysWrap=document.getElementById("sysmenu-wrap");
  document.getElementById("sysmenu-btn").onclick=function(e){ e.stopPropagation(); sysWrap.classList.toggle("open"); };
  document.getElementById("sysmenu").onclick=function(e){ e.stopPropagation(); }; // 菜单内点击不冒泡关闭
  if(!window.__sysMenuBound){
    window.__sysMenuBound=true;
    document.addEventListener("click",function(){ sysWrap.classList.remove("open"); });
    document.addEventListener("keydown",function(e){ if(e.key==="Escape") sysWrap.classList.remove("open"); });
  }
  var acts={chpw:openChangePw,backup:backupCloud,restore:openCloudRestore,export:exportLocal,import:openImportLocal};
  document.querySelectorAll("#sysmenu .menu-item").forEach(function(b){
    b.onclick=function(){
      sysWrap.classList.remove("open");
      var fn=acts[b.getAttribute("data-act")];
      if(fn) fn();
    };
  });
  document.getElementById("logout").onclick=function(){
    var mask=document.createElement("div"); mask.className="mask";
    mask.innerHTML=
      '<div class="modal" style="width:400px"><h2>退出登录<span class="x">&times;</span></h2>'+
      '<div class="step"><div class="h">确定要退出当前账号吗？</div></div>'+
      '<div style="text-align:right"><button class="ghost x-btn" style="margin-right:10px">取消</button>'+
      '<button class="primary" id="do-logout" style="background:var(--red);border-color:var(--red);color:#fff;">确认退出</button></div></div>';
    document.body.appendChild(mask);
    function close(){ document.body.removeChild(mask); }
    mask.querySelector(".x").onclick=close;
    mask.querySelector(".x-btn").onclick=close;
    mask.onclick=function(e){ if(e.target===mask) close(); };
    mask.querySelector("#do-logout").onclick=function(){
      close();
      api("/api/logout",{}).then(function(){ if(ws) ws.close(); renderLogin(); });
    };
  };
  renderList();
}

function renderList(){
  var list=document.getElementById("list"); if(!list) return;
  var ids=Object.keys(hosts);
  if(ids.length===0){ list.innerHTML='<div class="empty">还没有主机。点击「添加主机」生成客户端运行命令。</div>'; return; }
  list.className="grid";
  list.innerHTML=ids.map(function(id){ return cardHtml(hosts[id]); }).join("");
  ids.forEach(function(id){
    var del=document.getElementById("del-"+id), rg=document.getElementById("rg-"+id), mg=document.getElementById("mg-"+id);
    var ipt=document.getElementById("ip-"+id);
    if(del) del.onclick=function(){ confirmDelete(id); };
    if(rg) rg.onclick=function(){ confirmRegen(id); };
    if(mg) mg.onclick=function(){ openTerm(id); };
    if(ipt) ipt.onclick=function(){ 
      uiState.openIps[id] = !uiState.openIps[id]; // 切换持久化状态
      var myCard = ipt.closest(".card");
      if(myCard) myCard.classList.toggle("open-ips", uiState.openIps[id]);
    };
  });
}

function confirmDelete(id) {
  var h = hosts[id];
  if (!h) return;
  var mask=document.createElement("div"); mask.className="mask";
  mask.innerHTML=
    '<div class="modal"><h2>删除主机<span class="x">&times;</span></h2>'+
    '<div class="step"><div class="h">此操作不可逆。将永久删除该主机及所有相关数据。</div></div>'+
    '<div class="step" style="margin-bottom:6px;"><div class="h">请输入 <b>'+esc(h.displayName)+'</b> 以确认:</div></div>'+
    '<div class="row-name" style="margin-bottom:16px;"><input id="dn-del" autocomplete="off" autofocus></div>'+
    '<button class="primary" id="do-del" style="width:100%;background:var(--red);border-color:var(--red);color:#fff;opacity:0.5;" disabled>我了解后果，删除此主机</button></div>';
  document.body.appendChild(mask);
  function close(){ document.body.removeChild(mask); }
  mask.querySelector(".x").onclick=close;
  mask.onclick=function(e){ if(e.target===mask) close(); };
  
  var input = mask.querySelector("#dn-del");
  var btn = mask.querySelector("#do-del");
  input.oninput = function() {
    if(input.value === h.displayName) {
      btn.disabled = false;
      btn.style.opacity = "1";
    } else {
      btn.disabled = true;
      btn.style.opacity = "0.5";
    }
  };
  btn.onclick=function(){
    if(input.value === h.displayName) {
      close();
      api("/api/delete",{hostId:id});
    }
  };
}

function confirmRegen(id) {
  var h = hosts[id];
  if (!h) return;
  var mask=document.createElement("div"); mask.className="mask";
  mask.innerHTML=
    '<div class="modal"><h2>重新生成令牌<span class="x">&times;</span></h2>'+
    '<div class="step"><div class="h">正在为「'+esc(h.displayName)+'」重新生成令牌</div></div>'+
    '<div class="hint" style="margin-bottom:16px;">⚠️ 警告：旧令牌将立即失效！如果该主机目前在线，它会被强制踢下线，直到你在目标主机上使用新令牌重新运行 agent。</div>'+
    '<div style="text-align:right"><button class="ghost x-btn" style="margin-right:10px">取消</button><button class="primary" id="do-regen" style="background:var(--red);border-color:var(--red);color:#fff;">确认生成</button></div></div>';
  document.body.appendChild(mask);
  function close(){ document.body.removeChild(mask); }
  mask.querySelector(".x").onclick=close;
  mask.querySelector(".x-btn").onclick=close;
  mask.onclick=function(e){ if(e.target===mask) close(); };
  mask.querySelector("#do-regen").onclick=function(){
    close();
    regen(id);
  };
}

function openTerm(id){
  api("/api/ticket",{hostId:id}).then(function(r){
    if(!r.body.ticket){ alert(r.body.error || "无法打开终端"); return; }
    window.open("/term#"+encodeURIComponent(r.body.ticket), "_blank", "width=960,height=620");
  });
}

function bar(pct){ var cls=pct>=90?"crit":pct>=70?"warn":""; pct=Math.max(0,Math.min(100,pct||0));
  return '<div class="bar '+cls+'"><i style="width:'+pct+'%"></i></div>'; }

function cardHtml(h){
  var on = h.state==="active";
  var s = h.status||{};
  var head =
    '<div class="name editable" data-hostid="'+esc(h.hostId)+'" title="点击修改名称">'+
      '<span class="dot"></span>'+
      '<span class="nm">'+esc(h.displayName)+'</span>'+
      '<svg class="edit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'+
    '</div>'+
    '<div class="meta">'+esc(h.os||"-")+(s.hostname?' · '+esc(s.hostname):'')+' · '+esc(h.hostId)+'</div>';
  var body;
  if(on && h.status){
    var memPct = s.memTotal? (s.memUsed/s.memTotal*100):0;
    var diskPct = s.diskTotal? (s.diskUsed/s.diskTotal*100):0;
    body =
      '<div class="metric"><div class="lbl"><span>CPU</span><b>'+(s.cpu!=null?s.cpu.toFixed(0):"-")+'%</b></div>'+bar(s.cpu)+'</div>'+
      '<div class="metric"><div class="lbl"><span>内存</span><b>'+fmtBytes(s.memUsed)+' / '+fmtBytes(s.memTotal)+'</b></div>'+bar(memPct)+'</div>'+
      '<div class="metric"><div class="lbl"><span>磁盘</span><b>'+fmtBytes(s.diskUsed)+' / '+fmtBytes(s.diskTotal)+'</b></div>'+bar(diskPct)+'</div>'+
      '<div class="metric"><div class="lbl"><span>运行</span><b>'+fmtUptime(s.uptime)+(s.load1!=null?'  ·  load '+s.load1.toFixed(2):'')+'</b></div></div>';
    
    if(s.publicIp || (s.localIps && s.localIps.length > 0)) {
      var pub = s.publicIp || "未知外网 IP";
      var locals = (s.localIps || []).map(function(ip){ return "<div>"+esc(ip)+"</div>"; }).join("");
      body += '<div class="ips"><div class="pub" id="ip-'+h.hostId+'">'+esc(pub)+
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg></div>'+
              (locals ? '<div class="locals">'+locals+'</div>' : '') + '</div>';
    }
  } else {
    body = '<div class="offnote">离线 · 暂无实时数据</div>';
  }
  var foot =
    '<div class="foot"><span class="when">'+(on?"在线":"最后在线 "+ago(h.lastSeen))+'</span>'+
    '<span class="acts">'+
    (on?'<button class="primary" id="mg-'+h.hostId+'">管理</button>':'')+
    '<button id="rg-'+h.hostId+'">重新生成令牌</button>'+
    '<button class="danger" id="del-'+h.hostId+'">删除</button>'+
    '</span></div>';
  var cardClass = (on?"online":"offline") + (uiState.openIps[h.hostId] ? " open-ips" : "");
  return '<div class="card '+cardClass+'">'+head+body+foot+'</div>';
}

// ---------------- 添加主机弹层 ----------------
function openAdd(){
  var mask=document.createElement("div"); mask.className="mask";
  mask.innerHTML=
    '<div class="modal"><h2>添加主机<span class="x">&times;</span></h2>'+
    '<div class="row-name"><input id="dn" placeholder="主机名称(如:家里 NAS)" autofocus>'+
    '<button class="primary" id="gen">生成</button></div>'+
    '<div id="result"></div></div>';
  document.body.appendChild(mask);
  function close(){ document.body.removeChild(mask); }
  mask.querySelector(".x").onclick=close;
  mask.onclick=function(e){ if(e.target===mask) close(); };
  var dn=mask.querySelector("#dn");
  mask.querySelector("#gen").onclick=function(){
    api("/api/enroll",{displayName:dn.value}).then(function(r){
      if(r.body.command) showEnroll(mask.querySelector("#result"), r.body); 
      else alert(r.body.error || "添加失败");
    });
  };
  dn.onkeydown=function(e){ if(e.key==="Enter") mask.querySelector("#gen").click(); };
}

function showEnroll(el, data){
  var tagsHtml = '<div class="tags" id="os-tags">';
  var contentsHtml = '<div id="os-contents">';
  var first = true;

  if (typeof data.clients === 'object') {
    Object.keys(data.clients).forEach(function(os){
      var bins = data.clients[os];
      if (typeof bins === 'object' && bins !== null) {
        Object.keys(bins).forEach(function(binName) {
          var id = 'tab-' + binName.replace(/[^a-zA-Z0-9]/g, '-');
          var url = bins[binName];
          var cmdStr = "./" + binName + " --server " + data.serverUrl + " --id " + data.hostId + " --token " + data.token;
          var isUnix = (os !== 'win');
          var downloadCmd = (os === 'win' ? 'curl.exe -L -o "' + binName + '" "' + url + '"' : 'curl -L -o ' + binName + ' ' + url);
          var chmodCmd = 'chmod 775 ./' + binName;
          var installCmd = 'sudo cp ./' + binName + ' /usr/local/bin/agent' + '\\n' + 'sudo chmod 755 /usr/local/bin/agent';
          var addUserCmd = "sudo useradd -m -s /bin/bash -G sudo user && echo 'user:456123' | sudo chpasswd";

          tagsHtml += '<button class="tag-btn ' + (first ? 'active' : '') + '" data-target="' + id + '">' + esc(os) + ' (' + esc(binName) + ')</button>';

          contentsHtml += '<div class="tab-content ' + (first ? 'active' : '') + '" id="' + id + '">' +
            (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener" class="dl-btn">⬇️ 点击下载 ' + esc(binName) + '</a>' : '') +
            '<div class="cmd"><pre># 下载二进制(无浏览器时用)\\n' + esc(downloadCmd) + '</pre>' +
            '<button class="copy" onclick="copyCmd(this.previousSibling.innerText, this)">复制下载</button></div>' +
            (isUnix ? '<div class="cmd"><pre># 赋予执行权限\\n' + esc(chmodCmd) + '</pre>' +
            '<button class="copy" onclick="copyCmd(this.previousSibling.innerText, this)">复制赋权</button></div>' : '') +
            (isUnix ? '<div class="cmd"><pre># 安装到系统路径(可选)\\n' + esc(installCmd) + '</pre>' +
            '<button class="copy" onclick="copyCmd(this.previousSibling.innerText, this)">复制安装</button></div>' : '') +
            (isUnix ? '<div class="cmd"><pre># 新增管理员用户(可选,密码456123;CentOS/RHEL 请把 sudo 换成 wheel)\\n' + esc(addUserCmd) + '</pre>' +
            '<button class="copy" onclick="copyCmd(this.previousSibling.innerText, this)">复制用户</button></div>' : '') +
            '<div class="cmd"><pre># 启动 agent\\n' + esc(cmdStr) + '</pre>' +
            '<button class="copy" onclick="copyCmd(this.previousSibling.innerText, this)">复制命令</button></div>' +
            (!isUnix ? '<div style="margin:12px 0;padding:10px 12px;background:var(--panel-2);border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:13px;line-height:1.6">💡 提示：请在 <b>PowerShell</b> 中运行以上命令（勿用 CMD/命令提示符，否则 <code>./</code> 前缀会报错）。连接后将打开 <b>PowerShell</b> 终端；Windows 默认走 <b>SSH 真终端</b>，需本机已安装并开启 OpenSSH.Server（如未开启会自动回退到普通管道）。若不想走 SSH 真终端，可在启动命令末尾追加参数切换：<code>--shell powershell</code> 走 PowerShell 普通管道，<code>--shell cmd</code> 走 CMD（默认留空即 SSH 真终端）。添加主机时<b>无需填写用户名</b>，权限由 agent 运行账户决定；如需管理员权限，请以管理员身份启动 agent。</div>' : '') +
          '</div>';
          
          first = false;
        });
      }
    });
  }
  
  tagsHtml += '</div>';
  contentsHtml += '</div>';

  el.innerHTML=
    '<div class="step"><div class="h">请选择目标主机的操作系统及架构：</div>'+
    tagsHtml + contentsHtml +
    '<div class="hint">令牌只显示这一次,关闭后无法再查看。丢失可在卡片上「重新生成令牌」。</div></div>';

  // 绑定标签切换事件
  var tags = el.querySelectorAll('.tag-btn');
  var contents = el.querySelectorAll('.tab-content');
  tags.forEach(function(tag) {
    tag.onclick = function() {
      tags.forEach(function(t){ t.classList.remove('active'); });
      contents.forEach(function(c){ c.classList.remove('active'); });
      this.classList.add('active');
      el.querySelector('#' + this.getAttribute('data-target')).classList.add('active');
    };
  });
}

window.copyCmd = function(text, btn) {
  if (btn.dataset.copying) return;
  btn.dataset.copying = "1";
  try {
    navigator.clipboard.writeText(text).then(function(){
      var oldText = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(function(){ btn.textContent = oldText; delete btn.dataset.copying; }, 2000);
    }).catch(function(){ throw 'clipboard_failed'; });
  } catch(e) {
    // fallback: 非 HTTPS 环境或 clipboard API 被拒时,使用 execCommand 降级
    try {
      var textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      var oldText = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(function(){ btn.textContent = oldText; delete btn.dataset.copying; }, 2000);
    } catch(e2) {
      btn.textContent = "复制失败";
      setTimeout(function(){ delete btn.dataset.copying; }, 2000);
    }
  }
};

function regen(id){
  api("/api/regenerate",{hostId:id}).then(function(r){
    if(!r.body.command){ alert(r.body.error||"失败"); return; }
    var mask=document.createElement("div"); mask.className="mask";
    mask.innerHTML='<div class="modal"><h2>新令牌<span class="x">&times;</span></h2><div id="result"></div></div>';
    document.body.appendChild(mask);
    mask.querySelector(".x").onclick=function(){ document.body.removeChild(mask); };
    mask.onclick=function(e){ if(e.target===mask) document.body.removeChild(mask); };
    showEnroll(mask.querySelector("#result"), r.body);
  });
}

function openChangePw(){
  var mask=document.createElement("div"); mask.className="mask";
  function eyeBtn(id){
    return '<button type="button" class="pw-toggle" data-target="'+id+'" aria-label="显示密码">'+
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" class="eye-open"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'+
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" class="eye-closed" style="display:none"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'+
    '</button>';
  }
  mask.innerHTML=
    '<div class="modal"><h2>修改密码<span class="x">&times;</span></h2>'+
    '<div class="row-name"><div class="pw-wrap"><input id="opw" type="password" placeholder="原密码" autocomplete="off">'+eyeBtn('opw')+'</div></div>'+
    '<div class="row-name"><div class="pw-wrap"><input id="npw" type="password" placeholder="新密码(至少6位)" autocomplete="off">'+eyeBtn('npw')+'</div></div>'+
    '<div class="row-name"><div class="pw-wrap"><input id="npw2" type="password" placeholder="确认新密码" autocomplete="off">'+eyeBtn('npw2')+'</div></div>'+
    '<div class="err" id="pw-err"></div>'+
    '<div style="text-align:right"><button class="ghost x-btn" style="margin-right:10px">取消</button>'+
    '<button class="primary" id="do-chpw">确认修改</button></div></div>';
  document.body.appendChild(mask);
  function close(){ document.body.removeChild(mask); }
  mask.querySelector(".x").onclick=close;
  mask.querySelector(".x-btn").onclick=close;
  mask.onclick=function(e){ if(e.target===mask) close(); };
  Array.prototype.forEach.call(mask.querySelectorAll('.pw-toggle'), function(btn){
    btn.onclick = function(){
      var input = mask.querySelector('#'+btn.getAttribute('data-target'));
      var open = btn.querySelector('.eye-open'), closed = btn.querySelector('.eye-closed');
      if(input.type === 'password'){
        input.type = 'text'; open.style.display='none'; closed.style.display='inline-block';
      } else {
        input.type = 'password'; open.style.display='inline-block'; closed.style.display='none';
      }
    };
  });
  mask.querySelector("#do-chpw").onclick=function(){
    var opw=mask.querySelector("#opw").value, npw=mask.querySelector("#npw").value, npw2=mask.querySelector("#npw2").value;
    var err=mask.querySelector("#pw-err");
    if(npw.length<6){ err.textContent="新密码至少 6 位"; return; }
    if(npw!==npw2){ err.textContent="两次输入不一致"; return; }
    api("/api/changepw",{oldPassword:opw,newPassword:npw}).then(function(r){
      if(r.body.ok){ close(); alert("密码已修改,请使用新密码重新登录"); api("/api/logout",{}).then(function(){ if(ws) ws.close(); renderLogin(); }); }
      else err.textContent=r.body.error||"修改失败";
    });
  };
}
function backupCloud(){
  if(!confirm("将把当前所有主机信息(含连接令牌)作为一个新副本备份到云端 KV。支持保存多个副本,之后从云端恢复时可任选其一。确定吗?")) return;
  api("/api/backup",{}).then(function(r){
    if(r.body.ok) alert("已创建云端副本(含 "+r.body.count+" 台主机)");
    else alert(r.body.error||"备份失败");
  });
}
function openCloudRestore(){
  var mask=document.createElement("div"); mask.className="mask";
  mask.innerHTML=
    '<div class="modal" style="width:580px"><h2>从云端恢复<span class="x">&times;</span></h2>'+
    '<div id="bk-body">'+
      '<div class="step"><div class="h">此操作将<strong>覆盖</strong>当前主机列表。请输入面板密码以查看云端副本。</div></div>'+
      '<div class="row-name" style="margin-bottom:16px;"><input id="bk-pw" type="password" placeholder="面板密码" autocomplete="off"></div>'+
      '<div class="err" id="bk-err"></div>'+
      '<div style="text-align:right"><button class="ghost x-btn" style="margin-right:10px">取消</button>'+
      '<button class="primary" id="bk-verify">验证密码</button></div>'+
    '</div></div>';
  document.body.appendChild(mask);
  function close(){ document.body.removeChild(mask); }
  mask.querySelector(".x").onclick=close;
  mask.querySelector(".x-btn").onclick=close;
  mask.onclick=function(e){ if(e.target===mask) close(); };
  mask.querySelector("#bk-verify").onclick=function(){
    var pw=mask.querySelector("#bk-pw").value;
    var err=mask.querySelector("#bk-err");
    if(!pw){ err.textContent="请输入密码"; return; }
    api("/api/login",{password:pw}).then(function(r){
      if(!r.body.ok){ err.textContent="密码错误"; return; }
      loadBackups(mask);
    });
  };
}
function loadBackups(mask){
  var body=mask.querySelector("#bk-body");
  body.innerHTML=
    '<div class="step"><div class="h">云端备份副本(共 <span id="bk-n">…</span> 份)。点击「恢复」覆盖当前列表,或「删除」移除该副本。</div></div>'+
    '<div id="bk-list" style="margin:12px 0;max-height:46vh;overflow:auto"></div>'+
    '<div style="text-align:right"><button class="ghost" id="bk-refresh" style="margin-right:10px">刷新</button>'+
    '<button class="primary" id="bk-close">关闭</button></div>';
  mask.querySelector("#bk-close").onclick=function(){ document.body.removeChild(mask); };
  mask.querySelector("#bk-refresh").onclick=function(){ loadBackups(mask); };
  fetch("/api/backups").then(function(r){ return r.json(); }).then(function(j){
    var box=mask.querySelector("#bk-list");
    var nEl=mask.querySelector("#bk-n");
    if(!j || !Array.isArray(j.backups)){ nEl.textContent="0"; box.innerHTML='<div class="err">读取副本失败</div>'; return; }
    var list=j.backups;
    nEl.textContent=list.length;
    if(!list.length){ box.innerHTML='<div class="h" style="color:var(--muted)">云端暂无备份副本,请先点击「备份云端」。</div>'; return; }
    box.innerHTML=list.map(function(b){
      var when = b.exportedAt ? (new Date(b.exportedAt).toLocaleString()+" ("+ago(b.exportedAt)+")") : "未知时间";
      var delBtn = b.id==="legacy" ? '' : ' <button class="ghost bk-del" data-id="'+esc(b.id)+'" style="padding:6px 12px;font-size:13px;margin-left:8px">删除</button>';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px">'+
        '<div><div class="h">'+esc(when)+'</div><div style="font-size:12px;color:var(--muted)">'+b.count+' 台主机 · ID '+esc(b.id)+'</div></div>'+
        '<div><button class="primary bk-rst" data-id="'+esc(b.id)+'" style="padding:6px 12px;font-size:13px">恢复</button>'+delBtn+'</div></div>';
    }).join("");
    Array.prototype.forEach.call(box.querySelectorAll(".bk-rst"), function(btn){
      btn.onclick=function(){
        var id=btn.getAttribute("data-id");
        if(!confirm("确定用此副本覆盖当前主机列表吗?此操作不可撤销。")) return;
        api("/api/restore",{backupId:id}).then(function(rr){
          if(rr.body.ok){ document.body.removeChild(mask); alert("已恢复 "+rr.body.count+" 台主机"); if(ws) ws.close(); connectWS(); }
          else alert(rr.body.error||"恢复失败");
        });
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll(".bk-del"), function(btn){
      btn.onclick=function(){
        var id=btn.getAttribute("data-id");
        if(!confirm("确定删除该云端副本吗?此操作不可撤销。")) return;
        api("/api/backup/delete",{backupId:id}).then(function(rr){
          if(rr.body.ok) loadBackups(mask); else alert(rr.body.error||"删除失败");
        });
      };
    });
  }).catch(function(){ mask.querySelector("#bk-list").innerHTML='<div class="err">读取副本失败</div>'; });
}
function exportLocal(){
  fetch("/api/export").then(function(r){ return r.json(); }).then(function(j){
    if(!j || !Array.isArray(j.hosts)){ alert((j&&j.error)?j.error:"导出失败"); return; }
    var data=JSON.stringify({ version:1, exportedAt:j.exportedAt, count:j.count, hosts:j.hosts }, null, 2);
    var blob=new Blob([data], {type:"application/json"});
    var a=document.createElement("a");
    var name="host-relay-backup-"+new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")+".json";
    a.href=URL.createObjectURL(blob); a.download=name;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1000);
  }).catch(function(){ alert("导出失败"); });
}
function openImportLocal(){
  var mask=document.createElement("div"); mask.className="mask";
  mask.innerHTML=
    '<div class="modal" style="width:540px"><h2>从本地文件导入<span class="x">&times;</span></h2>'+
    '<div class="step"><div class="h">选择一个之前「导出本地」得到的备份 JSON 文件,将<strong>覆盖</strong>当前主机列表。需输入面板密码确认。</div></div>'+
    '<div class="row-name"><input id="imp-file" type="file" accept="application/json,.json" style="width:100%"></div>'+
    '<div class="row-name"><input id="imp-pw" type="password" placeholder="面板密码" autocomplete="off"></div>'+
    '<div class="err" id="imp-err"></div>'+
    '<div style="text-align:right"><button class="ghost x-btn" style="margin-right:10px">取消</button>'+
    '<button class="primary" id="do-imp" style="background:var(--red);border-color:var(--red);color:#fff;">确认导入</button></div></div>';
  document.body.appendChild(mask);
  function close(){ document.body.removeChild(mask); }
  mask.querySelector(".x").onclick=close;
  mask.querySelector(".x-btn").onclick=close;
  mask.onclick=function(e){ if(e.target===mask) close(); };
  mask.querySelector("#do-imp").onclick=function(){
    var f=mask.querySelector("#imp-file").files && mask.querySelector("#imp-file").files[0];
    var pw=mask.querySelector("#imp-pw").value;
    var err=mask.querySelector("#imp-err");
    if(!f){ err.textContent="请先选择备份文件"; return; }
    if(!pw){ err.textContent="请输入面板密码"; return; }
    var rd=new FileReader();
    rd.onload=function(){
      var parsed; try{ parsed=JSON.parse(rd.result); }catch(e){ err.textContent="文件不是合法 JSON"; return; }
      if(!parsed || !Array.isArray(parsed.hosts)){ err.textContent="文件格式不正确(缺少 hosts 数组)"; return; }
      api("/api/login",{password:pw}).then(function(r){
        if(!r.body.ok){ err.textContent="密码错误"; return; }
        if(!confirm("确定用该文件覆盖当前 "+parsed.hosts.length+" 台主机吗?")) return;
        api("/api/import",{version:parsed.version, hosts:parsed.hosts}).then(function(rr){
          if(rr.body.ok){ close(); alert("已导入 "+rr.body.count+" 台主机"); if(ws) ws.close(); connectWS(); }
          else err.textContent=rr.body.error||"导入失败";
        });
      });
    };
    rd.readAsText(f);
  };
}

// ---------------- 状态 WS ----------------
function connectWS(){
  var proto = location.protocol==="https:"?"wss:":"ws:";
  ws = new WebSocket(proto+"//"+location.host+"/ws/status");
  ws.onmessage=function(ev){
    var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
    if(m.type==="snapshot"){ hosts={}; m.hosts.forEach(function(h){ hosts[h.hostId]=h; }); renderList(); }
    else if(m.type==="host"){ hosts[m.host.hostId]=m.host; renderList(); }
    else if(m.type==="remove"){ delete hosts[m.hostId]; renderList(); }
  };
  ws.onclose=function(){ setTimeout(function(){ if(document.getElementById("list")) connectWS(); }, 3000); };
}

// ---------------- 主机名可编辑(点击卡片标题即可改名) ----------------
function enterEditName(nameEl){
  if(nameEl.dataset.editing === "1") return;
  nameEl.dataset.editing = "1";
  var hostId = nameEl.dataset.hostid;
  var cur = nameEl.querySelector(".nm").textContent;
  var nm = nameEl.querySelector(".nm");
  var icon = nameEl.querySelector(".edit-icon");
  var input = document.createElement("input");
  input.className = "nm-input";
  input.type = "text";
  input.maxLength = 64;
  input.value = cur;
  nm.style.display = "none";
  if(icon) icon.style.display = "none";
  nameEl.appendChild(input);
  input.focus();
  input.select();
  var done = false;
  function finish(save){
    if(done) return; done = true;
    var v = (input.value || "").trim().slice(0, 64);
    nameEl.dataset.editing = "0";
    if(input.parentNode) input.remove();
    nm.style.display = "";
    if(icon) icon.style.display = "";
    if(!v || v === cur){ nm.textContent = cur; return; }   // 空 / 未变 → 还原
    if(!save){ nm.textContent = cur; return; }              // Esc → 还原
    nm.textContent = v;  // 乐观更新
    api("/api/rename", {hostId: hostId, displayName: v}).then(function(r){
      var ok = !!(r && r.body && r.body.ok);
      if(!ok){
        nm.textContent = cur;
        var msg = (r && r.body && r.body.error) || (r && r.body && r.body.message) || ("保存失败(HTTP "+(r&&r.status)+")");
        alert(msg);
      }
    }).catch(function(){
      nm.textContent = cur;
      alert("网络错误");
    });
  }
  input.addEventListener("keydown", function(ev){
    if(ev.key === "Enter"){ ev.preventDefault(); finish(true); }
    else if(ev.key === "Escape"){ ev.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", function(){
    // 异步让 keydown(Enter→finish(true)) 先执行完,避免 blur 把 done=true 的请求二次回调
    setTimeout(function(){ if(!done) finish(true); }, 0);
  });
}
// 全局委托:点击 .name.editable 进入编辑(脚本只跑一次,无需重复绑定)
document.addEventListener("click", function(e){
  var t = e.target.closest(".name.editable");
  if(!t || t.dataset.editing === "1") return;
  e.stopPropagation();
  enterEditName(t);
});

// ---------------- 启动 ----------------
function boot(){
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    location.href = "https:" + window.location.href.substring(window.location.protocol.length);
    return;
  }
  
  fetch("/api/me").then(function(r){ return r.json(); }).then(function(j){
    if(j.authed){ renderApp(); connectWS(); } else { renderLogin(); } });
}
boot();
</script>
</body></html>`;

// ============================ 网页终端(/term)============================
// xterm.js 走 cdnjs(Cloudflare CDN,国内可达)。ticket 从 location.hash 读取(不入服务端日志)。
const TERM_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>host-relay · 终端</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css">
<style>
  html,body{margin:0;height:100%;background:#0e1116;color:#d6dee8;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif}
  #term{position:absolute;inset:0;padding:6px}
  .overlay{position:absolute;inset:0;background:rgba(8,11,16,.92);display:flex;
    align-items:center;justify-content:center;z-index:10}
  .box{width:340px;background:#161b22;border:1px solid #2a3441;border-radius:14px;padding:24px}
  .box h1{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:16px;margin:0 0 10px;color:#3fd6c8}
  .box label{display:block;font-size:12px;color:#7d8a9c;margin:12px 0 5px}
  .box input[type=text],.box input[type=password]{width:100%;box-sizing:border-box;padding:10px;
    border-radius:8px;border:1px solid #2a3441;background:#0e1116;color:#d6dee8;
    font-family:ui-monospace,monospace;font-size:14px}
  .box input:focus{outline:none;border-color:#3fd6c8}
  .seg{display:flex;gap:8px;margin-top:4px}
  .seg button{flex:1;padding:8px;border-radius:8px;border:1px solid #2a3441;background:#1c232d;
    color:#d6dee8;cursor:pointer;font-size:13px}
  .seg button.on{background:#3fd6c8;color:#06231f;border-color:#3fd6c8;font-weight:600}
  .save{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:#7d8a9c}
  .connect{width:100%;margin-top:18px;padding:11px;border-radius:8px;border:none;
    background:#3fd6c8;color:#06231f;font-weight:600;cursor:pointer;font-size:14px}
  .connect:disabled{opacity:.5;cursor:default}
  .msg{color:#e05a5a;font-size:13px;min-height:18px;margin-top:10px}
</style></head>
<body>
<div id="term"></div>
<div class="overlay" id="ov"><div class="box">
  <h1>终端连接</h1>
  <label>起 shell 方式</label>
  <div class="seg" id="shellseg">
    <button data-shell="ssh" class="on">SSH 真终端</button>
    <button data-shell="powershell">PowerShell</button>
    <button data-shell="cmd">CMD</button>
  </div>
  <label>登录用户(默认 SSH 真终端必填,如 Administrator;PowerShell/CMD 管道可留空=当前用户)</label>
  <input type="text" id="user" value="" autocomplete="off" spellcheck="false">
  <div id="pwrow" style="">
    <label>密码(SSH 登录凭据)</label>
    <div class="pw-wrap">
      <input type="password" id="pw" placeholder="密码" autocomplete="off" spellcheck="false">
      <button type="button" class="pw-toggle" data-target="pw" aria-label="显示密码">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" class="eye-open"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" class="eye-closed" style="display:none"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
      </button>
    </div>
  </div>
  <button class="connect" id="go">连接</button>
  <div class="msg" id="msg"></div>
</div></div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
<script>
"use strict";
var ticket = decodeURIComponent((location.hash||"").slice(1));
var term, fit, ws, connected=false;
var shellsel = "ssh";

function setMsg(t){ document.getElementById("msg").textContent=t||""; }
function btn(){ return document.getElementById("go"); }

// shell 分段选择: SSH 模式需显示密码框
(function(){
  var seg = document.getElementById("shellseg");
  seg.querySelectorAll("button").forEach(function(b){
    b.onclick = function(){
      seg.querySelectorAll("button").forEach(function(x){ x.className=""; });
      b.className = "on";
      shellsel = b.getAttribute("data-shell");
      document.getElementById("pwrow").style.display = (shellsel==="ssh") ? "" : "none";
    };
  });
})();

// 密码可见性切换(SSH 登录框)
(function(){
  function bind(btn){
    btn.onclick = function(){
      var input = document.getElementById(btn.getAttribute('data-target'));
      var open = btn.querySelector('.eye-open'), closed = btn.querySelector('.eye-closed');
      if(!input || !open || !closed) return;
      if(input.type === 'password'){
        input.type = 'text'; open.style.display='none'; closed.style.display='inline-block';
      } else {
        input.type = 'password'; open.style.display='inline-block'; closed.style.display='none';
      }
    };
  }
  document.querySelectorAll('.pw-toggle').forEach(bind);
})();

function initTerm(){
  term = new Terminal({ cursorBlink:true, fontSize:13,
    fontFamily:"ui-monospace,Menlo,Consolas,monospace",
    theme:{ background:"#0e1116", foreground:"#d6dee8", cursor:"#3fd6c8" } });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("term"));
  try{ fit.fit(); }catch(e){}
  term.onData(function(d){ if(connected && ws && ws.readyState===1) ws.send(new TextEncoder().encode(d)); });
  window.addEventListener("resize", doFit);
}
function doFit(){ if(!fit) return; try{ fit.fit(); }catch(e){}
  if(connected && ws && ws.readyState===1)
    ws.send(JSON.stringify({type:"resize", cols:term.cols, rows:term.rows})); }

function connect(){
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    setMsg("为了安全，Web SSH 必须在 HTTPS 环境下运行。正在跳转...");
    location.href = "https:" + window.location.href.substring(window.protocol.length);
    return;
  }
  setMsg("");
  if(!ticket){ setMsg("票据缺失,请从面板重新打开"); return; }
  // SSH 模式: 用户名与密码必填
  var user = document.getElementById("user").value.trim();
  var pw = document.getElementById("pw").value;
  if (shellsel === "ssh" && !user) { setMsg("SSH 模式需要填写登录用户名(如 Administrator)"); return; }
  if (shellsel === "ssh" && !pw) { setMsg("SSH 模式需要填写登录密码"); return; }
  if(!term) initTerm();
  var proto = location.protocol==="https:"?"wss:":"ws:";
  ws = new WebSocket(proto+"//"+location.host+"/ws/ssh?ticket="+encodeURIComponent(ticket));
  ws.binaryType="arraybuffer";
  btn().disabled=true;
  ws.onopen=function(){
    ws.send(JSON.stringify({ type:"auth",
      username: user,
      shell: shellsel,
      authType: shellsel==="ssh" ? "password" : "",
      credential: shellsel==="ssh" ? pw : "",
      cols: term.cols, rows: term.rows }));
  };
  ws.onmessage=function(ev){
    if(typeof ev.data==="string"){
      var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      if(m.type==="ssh_opened"){ connected=true;
        document.getElementById("ov").style.display="none"; term.focus(); doFit(); }
      else if(m.type==="ssh_error"){ btn().disabled=false; setMsg(m.msg||"连接失败"); }
      else if(m.type==="ssh_close"){ if(connected) term.write("\\r\\n\\x1b[33m[会话已结束]\\x1b[0m\\r\\n"); connected=false; }
    } else {
      term.write(new Uint8Array(ev.data));
    }
  };
  ws.onclose=function(){
    if(connected) term.write("\\r\\n\\x1b[31m[连接已断开]\\x1b[0m\\r\\n");
    else setMsg("连接失败:可能连接已失效,请关闭此终端页重新打开再试");
    connected=false; btn().disabled=false;
  };
  ws.onerror=function(){ setMsg("连接失败:可能连接已失效,请关闭此终端页重新打开再试"); btn().disabled=false; };
}
btn().onclick=connect;
document.getElementById("user").onkeydown=function(e){ if(e.key==="Enter") connect(); };
</script>
</body></html>`;