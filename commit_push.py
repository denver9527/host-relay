#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 通过 GitHub REST API 提交多个文件到 main 并推送(绕开 git https 凭证交互)
# token 通过环境变量 GH_TOKEN 注入(不读文件, 不回显)
import subprocess, os, sys, json, base64

TOKEN = os.environ.get("GH_TOKEN")
if not TOKEN:
    sys.stderr.write("GH_TOKEN not set\n")
    sys.exit(1)

REPO = "denver9527/host-relay"
BRANCH = "main"
FILES = [
    "src/agent/main.go",
    "src/worker/worker.js",
    "build_agents.sh",
    "push_v106.py",
    "version.txt",
    "replace_assets.py",
]
MSG = ("feat: 版本号单一真相源 + 编译期自动注入; worker 提示增强\n\n"
       "- 新增 version.txt 作为唯一版本真相源\n"
       "- main.go version 改 const->var, 支持 -ldflags -X main.version 注入\n"
       "- build_agents.sh 读 version.txt 注入 agent 版本并同步 worker.js VERSION\n"
       "- push_v106.py 改从 version.txt 读取版本\n"
       "- worker.js: 添加主机卡片补充 --shell powershell/cmd 切换说明; 下载命令改 curl.exe (兼容 PS 5.1)\n"
       "- 新增 replace_assets.py: 删除并覆盖 release asset")


def api(method, path, data=None):
    cmd = ["curl", "-sS", "-w", "\nHTTP_CODE:%{http_code}", "-X", method,
           "-H", "Authorization: Bearer " + TOKEN,
           "-H", "Accept: application/vnd.github+json",
           "-H", "X-GitHub-Api-Version: 2022-11-28",
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
    if not out.strip():
        return None, code
    try:
        return json.loads(out), code
    except Exception:
        sys.stderr.write("BAD JSON %s %s code=%s\n%s\n" % (method, path, code, out[:400]))
        sys.exit(1)


def main():
    # base
    ref, code = api("GET", "/repos/%s/git/refs/heads/%s" % (REPO, BRANCH))
    if code and "200" not in code and not isinstance(ref, dict):
        sys.stderr.write("GET ref failed code=%s\n" % code)
        sys.exit(1)
    base_sha = ref["object"]["sha"]
    print("base commit = %s" % base_sha)
    base_commit, _ = api("GET", "/repos/%s/git/commits/%s" % (REPO, base_sha))
    base_tree = base_commit["tree"]["sha"]

    # blobs
    tree_entries = []
    for f in FILES:
        if not os.path.exists(f):
            sys.stderr.write("SKIP missing %s\n" % f)
            continue
        with open(f, "rb") as fh:
            content = fh.read()
        b, c = api("POST", "/repos/%s/git/blobs" % REPO,
                   {"content": base64.b64encode(content).decode(), "encoding": "base64"})
        if "201" not in c:
            sys.stderr.write("blob failed for %s code=%s\n" % (f, c))
            sys.exit(1)
        tree_entries.append({"path": f, "mode": "100644", "type": "blob", "sha": b["sha"]})
        print("blob %s" % f)

    new_tree, c = api("POST", "/repos/%s/git/trees" % REPO,
                      {"base_tree": base_tree, "tree": tree_entries})
    if "201" not in c:
        sys.stderr.write("tree failed code=%s\n" % c)
        sys.exit(1)
    new_commit, c = api("POST", "/repos/%s/git/commits" % REPO,
                        {"message": MSG, "tree": new_tree["sha"], "parents": [base_sha]})
    if "201" not in c:
        sys.stderr.write("commit failed code=%s\n" % c)
        sys.exit(1)
    _, c = api("PATCH", "/repos/%s/git/refs/heads/%s" % (REPO, BRANCH),
               {"sha": new_commit["sha"]})
    if "200" not in c:
        sys.stderr.write("ref update failed code=%s\n" % c)
        sys.exit(1)
    print("PUSHED commit %s" % new_commit["sha"])


if __name__ == "__main__":
    main()
