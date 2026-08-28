#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 删除 GitHub release vX 的旧 asset, 重传本地新二进制(同名覆盖)
# token 通过环境变量 GH_TOKEN 注入(不读文件, 不回显)
import subprocess, os, sys, json

TOKEN = os.environ.get("GH_TOKEN")
if not TOKEN:
    sys.stderr.write("GH_TOKEN not set\n")
    sys.exit(1)

REPO = "denver9527/host-relay"
TAG = "v1.0.6"
OUT = "src/agent/out"
FILES = [
    "agent-linux-amd64",
    "agent-linux-arm64",
    "agent-linux-386",
    "agent-linux-arm",
    "agent-darwin-amd64",
    "agent-darwin-arm64",
    "agent-windows-amd64.exe",
]


def api(method, path, data=None, binary=None, raw=False, host=None):
    base = "https://uploads.github.com" if host == "uploads" else "https://api.github.com"
    cmd = ["curl", "-sS", "-w", "\nHTTP_CODE:%{http_code}", "-X", method,
           "-H", "Authorization: Bearer " + TOKEN,
           "-H", "Accept: application/vnd.github+json",
           "-H", "X-GitHub-Api-Version: 2022-11-28",
           base + path]
    if binary is not None:
        cmd += ["-H", "Content-Type: application/octet-stream", "--data-binary", "@-"]
        p = subprocess.run(cmd, input=binary, capture_output=True)
    elif data is not None:
        cmd += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
        p = subprocess.run(cmd, input=json.dumps(data), capture_output=True, text=True)
    else:
        p = subprocess.run(cmd, capture_output=True, text=True)
    out = p.stdout
    if isinstance(out, bytes):
        out = out.decode("utf-8", "replace")
    code = ""
    if "\nHTTP_CODE:" in out:
        out, code = out.rsplit("\nHTTP_CODE:", 1)
    if raw or not out.strip():
        return out, code
    try:
        return json.loads(out), code
    except Exception:
        sys.stderr.write("BAD JSON %s %s code=%s\n%s\n" % (method, path, code, out[:500]))
        sys.exit(1)


def main():
    # 1) 拿 release + 现有 assets
    rel, code = api("GET", "/repos/%s/releases/tags/%s" % (REPO, TAG))
    if code and "200" not in code and not isinstance(rel, dict):
        sys.stderr.write("GET release failed code=%s\n" % code)
        sys.exit(1)
    release_id = rel["id"]
    print("release id = %s" % release_id)

    # 2) 删旧 asset
    old = rel.get("assets", [])
    print("old assets: %d" % len(old))
    for a in old:
        r, c = api("DELETE", "/repos/%s/releases/assets/%d" % (REPO, a["id"]))
        print("  DELETE %s -> HTTP %s" % (a["name"], c))
    print("all old assets deleted")

    # 3) 上传新
    for f in FILES:
        p = os.path.join(OUT, f)
        if not os.path.exists(p):
            print("SKIP missing %s" % p)
            continue
        with open(p, "rb") as fh:
            blob = fh.read()
        print("UPLOAD %s (%d bytes)" % (f, len(blob)))
        _, c = api("POST",
                   "/repos/%s/releases/%d/assets?name=%s" % (REPO, release_id, f),
                   binary=blob, host="uploads")
        print("  -> HTTP %s" % c)
    print("DONE")


if __name__ == "__main__":
    main()
