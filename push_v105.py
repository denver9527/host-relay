import json, subprocess, sys, os

ROOT = "C:/Users/Administrator/host-relay"
REPO = "denver9527/host-relay"
OUT = os.path.join(ROOT, "out")

# 提交的源码文件(在 v1.0.5 基础上更新的 + 新增的)
FILES = [
    "src/worker/worker.js",
    "src/agent/main.go",
    "src/agent/shell_unix.go",
    "src/agent/shell_windows.go",
    "src/worker/wrangler.toml",
    "src/worker/README.md",
]

# 发版上传的 7 个二进制(命名与 worker.js CLIENT_URL 一致)
BINARIES = [
    "agent-linux-amd64",
    "agent-linux-arm64",
    "agent-linux-386",
    "agent-linux-arm",
    "agent-darwin-amd64",
    "agent-darwin-arm64",
    "agent-windows-amd64.exe",
]

def gh(method, path, data=None):
    cmd = ["gh", "api", "-X", method, path, "-H", "Accept: application/vnd.github+json"]
    if data is not None:
        cmd += ["--input", "-"]
        p = subprocess.run(cmd, input=json.dumps(data), capture_output=True, text=True)
    else:
        p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write("GH ERR %s %s\n%s\n" % (method, path, p.stderr[:800]))
        sys.exit(1)
    return p.stdout

def main():
    # 1) 当前 main 作为 base(动态获取,不硬编码旧 commit)
    ref = json.loads(gh("GET", f"repos/{REPO}/git/refs/heads/main"))
    base_sha = ref["object"]["sha"]
    base = json.loads(gh("GET", f"repos/{REPO}/git/commits/{base_sha}"))
    base_tree = base["tree"]["sha"]
    print("base commit:", base_sha, "tree:", base_tree)

    # 2) blobs
    blobs = []
    for f in FILES:
        with open(os.path.join(ROOT, f), "r", encoding="utf-8") as fh:
            content = fh.read()
        res = json.loads(gh("POST", f"repos/{REPO}/git/blobs",
                             {"content": content, "encoding": "utf-8"}))
        blobs.append({"path": f, "mode": "100644", "type": "blob", "sha": res["sha"]})
        print("blob", f, res["sha"][:10])

    # 3) tree(基于当前 main 树,仅覆盖/新增列出的文件,其余保留)
    tree = json.loads(gh("POST", f"repos/{REPO}/git/trees",
                          {"base_tree": base_tree, "tree": blobs}))
    print("tree:", tree["sha"])

    # 4) commit
    msg = ("v1.0.5: 固定三列卡片 + 弹窗可复制下载/chmod/cp 命令 + cid 拒绝采样防碰撞 "
           "+ 备份过滤 pending + 会话24h + 登录5次/30分锁 + Windows lookupUser 拒绝不存在用户 "
           "+ 默认密码123456(KV哈希优先) + 安全加固(改密回退/恢复二次确认/恢复防篡改)")
    commit = json.loads(gh("POST", f"repos/{REPO}/git/commits",
                            {"message": msg, "tree": tree["sha"], "parents": [base_sha]}))
    print("commit:", commit["sha"])

    # 5) 更新 main
    gh("PATCH", f"repos/{REPO}/git/refs/heads/main", {"sha": commit["sha"]})
    print("main ->", commit["sha"])

    # 6) 创建 release
    rel = json.loads(gh("POST", f"repos/{REPO}/releases",
                        {"tag_name": "v1.0.5", "name": "v1.0.5",
                         "body": msg, "draft": False, "prerelease": False}))
    rel_id = rel["id"]
    print("release id:", rel_id)

    # 7) 上传 7 个二进制(用 gh token + curl 裸字节 POST 到 uploads.github.com)
    token = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()
    if not token:
        sys.stderr.write("无法获取 gh token\n"); sys.exit(1)
    for name in BINARIES:
        path = os.path.join(OUT, name)
        if not os.path.exists(path):
            sys.stderr.write("MISSING %s\n" % path); sys.exit(1)
        url = f"https://uploads.github.com/repos/{REPO}/releases/{rel_id}/assets?name={name}"
        r = subprocess.run(["curl", "-s", "-X", "POST",
                            "-H", f"Authorization: Bearer {token}",
                            "-H", "Content-Type: application/octet-stream",
                            "--data-binary", f"@{path}", url],
                           capture_output=True, text=True)
        if r.returncode != 0 or '"id"' not in r.stdout:
            sys.stderr.write("UPLOAD FAIL %s: %s\n" % (name, r.stdout[:400])); sys.exit(1)
        print("asset done:", name)

    print("DONE v1.0.5")

if __name__ == "__main__":
    main()
