#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""替换 GitHub release v1.0.6 的 agent 二进制资产。

背景: v1.0.6 release 的资产上传于 2026-08-28T15:39Z, 而含 agent 安全修复的
提交 02deb8f 是 23:41(+0800), 差 2 分钟 -> 线上二进制缺 agent 端安全修复。
本脚本: 删旧资产 -> 上传重新编译的二进制 -> 抽样校验。

token 从 E:/git-denver9527.txt 读取, 绝不打印。
"""
import hashlib
import json
import os
import subprocess
import sys

ROOT = "C:/Users/Administrator/host-relay"
REPO = "denver9527/host-relay"
OUT = os.path.join(ROOT, "src", "agent", "out")
VERSION = open(os.path.join(ROOT, "version.txt"), encoding="utf-8").read().strip()
TAG = "v" + VERSION

BINARIES = [
    "agent-linux-amd64", "agent-linux-arm64", "agent-linux-386", "agent-linux-arm",
    "agent-darwin-amd64", "agent-darwin-arm64", "agent-windows-amd64.exe",
]

# 编译前记录的旧哈希(用于确认二进制确实变了)
OLD_HASH_FILE = "/tmp/agent_hashes_old.txt"


def load_token():
    env = os.environ.get("GH_TOKEN")
    if env and env.strip().startswith("ghp_"):
        return env.strip()
    with open("E:/git-denver9527.txt", encoding="utf-8") as fh:
        for line in fh:
            s = line.strip()
            if s.startswith("ghp_"):
                return s
    sys.stderr.write("NO ghp_ token\n")
    sys.exit(1)


TOKEN = load_token()
AUTH = "Authorization: Bearer " + TOKEN
ACCEPT = "Accept: application/vnd.github+json"
APIVER = "X-GitHub-Api-Version: 2022-11-28"


def api(method, path, data=None):
    cmd = ["curl", "-sS", "-w", "\nHTTP_CODE:%{http_code}", "-X", method,
           "-H", AUTH, "-H", ACCEPT, "-H", APIVER,
           "https://api.github.com" + path]
    if data is not None:
        cmd += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
        p = subprocess.run(cmd, input=json.dumps(data), capture_output=True, text=True)
    else:
        p = subprocess.run(cmd, capture_output=True, text=True)
    out = p.stdout
    code = ""
    if "\nHTTP_CODE:" in out:
        out, code = out.rsplit("\nHTTP_CODE:", 1)
    code = code.strip()
    if method == "DELETE":
        return code, out
    if not out.strip():
        return code, None
    try:
        return code, json.loads(out)
    except json.JSONDecodeError:
        sys.stderr.write("BAD JSON %s %s (code %s)\n%s\n" % (method, path, code, out[:400]))
        sys.exit(1)


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    print("TOKEN len: %d (值不打印)" % len(TOKEN))
    code, me = api("GET", "/user")
    if code != "200":
        sys.stderr.write("token 校验失败 HTTP %s\n" % code)
        sys.exit(1)
    print("whoami: %s" % (me or {}).get("login"))

    # 0) 与编译前哈希对比, 确认二进制确实变了
    print("\n=== 编译前后哈希对比 ===")
    old = {}
    if os.path.exists(OLD_HASH_FILE):
        for line in open(OLD_HASH_FILE, encoding="utf-8", errors="ignore"):
            parts = line.split()
            if len(parts) == 2:
                old[os.path.basename(parts[1])] = parts[0]
    changed = []
    for name in BINARIES:
        p = os.path.join(OUT, name)
        if not os.path.exists(p):
            sys.stderr.write("MISSING %s\n" % p)
            sys.exit(1)
        new = md5(p)
        was = old.get(name, "(无记录)")
        same = (was == new)
        changed.append(not same)
        print("  %-26s %s  %s" % (name, new[:12],
                                  "未变" if same else "已更新"))
    if not any(changed):
        print("\n!! 所有二进制哈希与编译前一致 —— 说明代码没有实质变化, 无需重传。中止。")
        sys.exit(0)

    # 1) 取 release
    code, rel = api("GET", "/repos/%s/releases/tags/%s" % (REPO, TAG))
    if code != "200":
        sys.stderr.write("取 release 失败 HTTP %s\n" % code)
        sys.exit(1)
    rel_id = rel["id"]
    print("\n=== release %s (id=%s) ===" % (TAG, rel_id))

    # 2) 删除旧资产
    print("\n=== 删除旧资产 ===")
    for a in list(rel.get("assets") or []):
        c, _ = api("DELETE", "/repos/%s/releases/assets/%s" % (REPO, a["id"]))
        print("  DELETE %-28s -> HTTP %s %s" % (a["name"], c, "OK" if c == "204" else "失败"))
        if c != "204":
            sys.stderr.write("删除失败, 中止: %s\n" % a["name"])
            sys.exit(1)

    # 3) 上传新二进制
    print("\n=== 上传新二进制 ===")
    for name in BINARIES:
        path = os.path.join(OUT, name)
        url = ("https://uploads.github.com/repos/%s/releases/%s/assets?name=%s"
               % (REPO, rel_id, name))
        r = subprocess.run(["curl", "-sS", "-X", "POST",
                            "-H", AUTH,
                            "-H", "Content-Type: application/octet-stream",
                            "--data-binary", "@" + path, url],
                           capture_output=True, text=True)
        ok = r.returncode == 0 and '"id"' in r.stdout
        print("  UPLOAD %-26s -> %s" % (name, "OK" if ok else "失败: " + r.stdout[:200]))
        if not ok:
            sys.stderr.write("上传中止\n")
            sys.exit(1)

    # 4) 复核: 列出资产 + 抽样下载校验 md5
    print("\n=== 复核资产清单 ===")
    code, rel2 = api("GET", "/repos/%s/releases/tags/%s" % (REPO, TAG))
    assets = {a["name"]: a for a in (rel2.get("assets") or [])}
    for name in BINARIES:
        a = assets.get(name)
        if not a:
            print("  %-26s 缺失!" % name)
            continue
        local_size = os.path.getsize(os.path.join(OUT, name))
        mark = "OK" if a["size"] == local_size else "大小不符!"
        print("  %-26s size=%-9d local=%-9d %s" % (name, a["size"], local_size, mark))

    sample = "agent-linux-amd64"
    a = assets.get(sample)
    if a:
        print("\n=== 抽样下载校验: %s ===" % sample)
        tmp = "/tmp/_verify_" + sample
        subprocess.run(["curl", "-sSL", "-o", tmp, "-H", AUTH,
                        "-H", "Accept: application/octet-stream",
                        a["url"]], check=True)
        remote_md5 = md5(tmp)
        local_md5 = md5(os.path.join(OUT, sample))
        print("  remote md5: %s" % remote_md5)
        print("  local  md5: %s" % local_md5)
        print("  结果: %s" % ("一致 ✅" if remote_md5 == local_md5 else "不一致 ❌"))
        os.remove(tmp)

    print("\nDONE %s" % TAG)


if __name__ == "__main__":
    main()
