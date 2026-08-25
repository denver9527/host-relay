"""一次性追加提交 push_v105.py + push_assets.py 到 main。

只追加这两个文件，不动其他文件、不重建 release。
用法：cd /c/Users/Administrator/host-relay && python3 push_scripts.py
"""
import json, subprocess, sys, os

ROOT = "C:/Users/Administrator/host-relay"
REPO = "denver9527/host-relay"
FILES = ["push_v105.py", "push_assets.py"]

def gh(method, path, data=None):
    cmd = ["gh", "api", "-X", method, path,
           "-H", "Accept: application/vnd.github+json"]
    if data is not None:
        cmd += ["--input", "-"]
        p = subprocess.run(cmd, input=json.dumps(data),
                           capture_output=True, text=True)
    else:
        p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write("GH ERR %s %s\nSTDERR: %s\nSTDOUT: %s\n" %
                         (method, path, p.stderr[:600], p.stdout[:600]))
        sys.exit(1)
    return p.stdout

def main():
    # 1) 当前 main base
    ref = json.loads(gh("GET", f"repos/{REPO}/git/refs/heads/main"))
    base_sha = ref["object"]["sha"]
    base = json.loads(gh("GET", f"repos/{REPO}/git/commits/{base_sha}"))
    base_tree = base["tree"]["sha"]
    print("base:", base_sha[:10], "tree:", base_tree[:10])

    # 2) 为两个脚本创建 blob
    blobs = []
    for f in FILES:
        with open(os.path.join(ROOT, f), "r", encoding="utf-8") as fh:
            content = fh.read()
        res = json.loads(gh("POST", f"repos/{REPO}/git/blobs",
                            {"content": content, "encoding": "utf-8"}))
        blobs.append({"path": f, "mode": "100644", "type": "blob", "sha": res["sha"]})
        print("blob", f, res["sha"][:10])

    # 3) 在 base_tree 上覆盖,只动这两文件
    tree = json.loads(gh("POST", f"repos/{REPO}/git/trees",
                         {"base_tree": base_tree, "tree": blobs}))
    print("new tree:", tree["sha"][:10])

    # 4) commit + 更新 main
    msg = "tools: 提交 push_v105.py + push_assets.py (git 协议被墙时用 GitHub API 发版的脚本)"
    commit = json.loads(gh("POST", f"repos/{REPO}/git/commits",
                           {"message": msg, "tree": tree["sha"],
                            "parents": [base_sha]}))
    print("commit:", commit["sha"][:10])

    gh("PATCH", f"repos/{REPO}/git/refs/heads/main", {"sha": commit["sha"]})
    print("main ->", commit["sha"])

if __name__ == "__main__":
    main()
