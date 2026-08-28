import json, subprocess, sys, os

ROOT = "C:/Users/Administrator/host-relay"
REPO = "denver9527/host-relay"
OUT = os.path.join(ROOT, "src", "agent", "out")
WORKER = os.path.join(ROOT, "src", "worker", "worker.js")
# 版本号单一真相源: 与 build_agents.sh 共用仓库根 version.txt, 全链路只改这一处
with open(os.path.join(ROOT, "version.txt"), "r", encoding="utf-8") as _f:
    VERSION = _f.read().strip()
TAG = "v" + VERSION

# token: 优先用环境变量 GH_TOKEN(bash 已验证可用), 回退读 E:\git-denver9527.txt(不回显)
def load_token():
    env = os.environ.get("GH_TOKEN")
    if env and env.strip().startswith("ghp_"):
        return env.strip()
    p = "E:/git-denver9527.txt"
    with open(p, "r", encoding="utf-8") as fh:
        for line in fh:
            s = line.strip()
            if s.startswith("ghp_"):
                return s
    sys.stderr.write("NO ghp_ token\n"); sys.exit(1)

TOKEN = load_token()
H = {"Authorization": "Authorization: Bearer " + TOKEN,
     "Accept": "Accept: application/vnd.github+json",
     "X-GitHub-Api-Version": "X-GitHub-Api-Version: 2022-11-28"}

def api(method, path, data=None, raw=False):
    cmd = ["curl", "-sS", "-w", "\nHTTP_CODE:%{http_code}", "-X", method, "-H", H["Authorization"],
           "-H", H["Accept"], "-H", H["X-GitHub-Api-Version"],
           "https://api.github.com" + path]
    if data is not None:
        cmd += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
        p = subprocess.run(cmd, input=json.dumps(data), capture_output=True, text=True)
    else:
        p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write("CURL ERR %s %s\n%s\n" % (method, path, p.stderr[:800])); sys.exit(1)
    out = p.stdout
    code = ""
    if "\nHTTP_CODE:" in out:
        out, code = out.rsplit("\nHTTP_CODE:", 1)
    if raw or not out.strip():
        return out
    try:
        obj = json.loads(out)
    except Exception:
        sys.stderr.write("BAD JSON %s %s (code %s)\n%s\n" % (method, path, code, out[:400])); sys.exit(1)
    if str(code) not in ("200", "201") and isinstance(obj, dict) and "message" in obj:
        sys.stderr.write("API ERR %s %s (code %s): %s\n" % (method, path, code, obj.get("message"))); sys.exit(1)
    return obj

def main():
    # debug: 验证脚本内 token 可用性
    print("TOKEN len:", len(TOKEN))
    u = api("GET", "/user")
    print("whoami:", u.get("login"), "type:", u.get("type"))
    # 1) base = 远程 main
    ref = api("GET", f"/repos/{REPO}/git/refs/heads/main")
    base_sha = ref["object"]["sha"]
    base = api("GET", f"/repos/{REPO}/git/commits/{base_sha}")
    base_tree = base["tree"]["sha"]
    print("base commit:", base_sha)

    # 2) blob for worker.js (新版 VERSION)
    with open(WORKER, "r", encoding="utf-8") as fh:
        content = fh.read()
    if VERSION not in content:
        sys.stderr.write("VERSION %s 未出现在 worker.js，中止\n" % VERSION); sys.exit(1)
    blob = api("POST", f"/repos/{REPO}/git/blobs",
               {"content": content, "encoding": "utf-8"})
    print("worker.js blob:", blob["sha"][:10])

    # 3) tree (基于 main 树, 仅覆盖 worker.js)
    tree = api("POST", f"/repos/{REPO}/git/trees",
               {"base_tree": base_tree,
                "tree": [{"path": "src/worker/worker.js", "mode": "100644",
                          "type": "blob", "sha": blob["sha"]}]})
    print("tree:", tree["sha"][:10])

    # 4) commit
    msg = ("v%s: agent 版本号改为编译期 -ldflags 注入(单一真相源 version.txt); "
           "Windows 真终端走本机 sshd(SSH 桥)+管道回退; 面板 SSH 真终端默认; "
           "登录锁放宽 10 分钟 + 清除锁定按钮; 修改密码/SSH 登录框密码可见切换; "
           "新增 cld3 部署配置; CLIENT_URL VERSION 升至 %s" % (VERSION, VERSION))
    commit = api("POST", f"/repos/{REPO}/git/commits",
                 {"message": msg, "tree": tree["sha"], "parents": [base_sha]})
    print("commit:", commit["sha"])

    # 5) 更新 main
    api("PATCH", f"/repos/{REPO}/git/refs/heads/main", {"sha": commit["sha"]})
    print("main ->", commit["sha"])

    # 6) 创建 release
    rel = api("POST", f"/repos/{REPO}/releases",
              {"tag_name": TAG, "name": TAG, "body": msg,
               "draft": False, "prerelease": False, "target_commitish": commit["sha"]})
    rel_id = rel["id"]
    print("release id:", rel_id)

    # 7) 上传 7 个二进制
    BINARIES = [
        "agent-linux-amd64", "agent-linux-arm64", "agent-linux-386", "agent-linux-arm",
        "agent-darwin-amd64", "agent-darwin-arm64", "agent-windows-amd64.exe",
    ]
    for name in BINARIES:
        path = os.path.join(OUT, name)
        if not os.path.exists(path):
            sys.stderr.write("MISSING %s\n" % path); sys.exit(1)
        url = f"https://uploads.github.com/repos/{REPO}/releases/{rel_id}/assets?name={name}"
        r = subprocess.run(["curl", "-sS", "-X", "POST",
                            "-H", H["Authorization"],
                            "-H", "Content-Type: application/octet-stream",
                            "--data-binary", f"@{path}", url],
                           capture_output=True, text=True)
        if r.returncode != 0 or '"id"' not in r.stdout:
            sys.stderr.write("UPLOAD FAIL %s: %s\n" % (name, r.stdout[:400])); sys.exit(1)
        print("asset done:", name)

    print("DONE", TAG)

if __name__ == "__main__":
    main()
