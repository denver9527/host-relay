import subprocess, sys, os

REPO = "denver9527/host-relay"
REL_ID = 376143627  # 已创建的 v1.0.5 release
OUT = "C:/Users/Administrator/host-relay/src/out"

BINARIES = [
    "agent-linux-amd64",
    "agent-linux-arm64",
    "agent-linux-386",
    "agent-linux-arm",
    "agent-darwin-amd64",
    "agent-darwin-arm64",
    "agent-windows-amd64.exe",
]

token = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()
if not token:
    sys.stderr.write("无法获取 gh token\n"); sys.exit(1)

for name in BINARIES:
    path = os.path.join(OUT, name)
    if not os.path.exists(path):
        sys.stderr.write("MISSING %s\n" % path); sys.exit(1)
    url = f"https://uploads.github.com/repos/{REPO}/releases/{REL_ID}/assets?name={name}"
    r = subprocess.run(["curl", "-s", "-X", "POST",
                        "-H", f"Authorization: Bearer {token}",
                        "-H", "Content-Type: application/octet-stream",
                        "--data-binary", f"@{path}", url],
                       capture_output=True, text=True)
    if r.returncode != 0 or '"id"' not in r.stdout:
        sys.stderr.write("UPLOAD FAIL %s: %s\n" % (name, r.stdout[:400])); sys.exit(1)
    print("asset done:", name)

print("ALL ASSETS UPLOADED")
