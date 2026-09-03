#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 cld3 账户凭据部署 host-relay 到 Cloudflare。
凭据从 E:\\cld3.txt 读取, 仅注入子进程环境变量, 绝不打印。
用法:
  python deploy_cld3.py --dry-run
  python deploy_cld3.py
"""
import os
import re
import subprocess
import sys

CRED = r"E:\cld3.txt"
CFG = r"C:\Users\Administrator\host-relay\src\worker\wrangler.cld3.toml"
CWD = r"C:\Users\Administrator\host-relay\src\worker"

raw = open(CRED, encoding="utf-8", errors="ignore").read()
m_email = re.search(r"[\w.+-]+@[\w.-]+\.\w+", raw)
m_key = re.search(r"\bcfk_[A-Za-z0-9_-]+", raw)
if not (m_email and m_key):
    raise SystemExit("凭据解析失败")
EMAIL, KEY = m_email.group(0), m_key.group(0)
print("账号: %s   |  Global Key 长度: %d (值不打印)" % (EMAIL, len(KEY)))

env = os.environ.copy()
env["CLOUDFLARE_EMAIL"] = EMAIL
env["CLOUDFLARE_API_KEY"] = KEY
env["CLOUDFLARE_API_TOKEN"] = ""
env["WRANGLER_SEND_METRICS"] = "false"
env["CI"] = "1"

# Windows 上 npx 实为 npx.cmd, 需经 shell 解析; 并确保 node 目录在 PATH 中
node_dir = r"C:\nvm4w\nodejs"
if node_dir not in env.get("PATH", ""):
    env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")

cmd = ["npx", "--yes", "wrangler@latest", "deploy", "--config", CFG]
if "--dry-run" in sys.argv:
    cmd.append("--dry-run")

print("\n执行: %s\n" % " ".join(cmd))
p = subprocess.run(" ".join(cmd), cwd=CWD, env=env, shell=True,
                   capture_output=True, text=True, encoding="utf-8", errors="replace")
out = (p.stdout or "") + (p.stderr or "")
# 脱敏: 万一 wrangler 回显了密钥
out = re.sub(r"cfk_[A-Za-z0-9_-]+", "cfk_***", out)
out = re.sub(r"(?i)(api[_-]?key\s*[:=]\s*)\S+", r"\1***", out)
print(out)
print("\nexit code = %d" % p.returncode)
sys.exit(p.returncode)
