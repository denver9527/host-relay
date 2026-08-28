# host-relay agent 启动器(自提升为管理员)
# 用法: powershell -ExecutionPolicy Bypass -File start-agent.ps1
# 或直接在资源管理器双击本文件。
$ErrorActionPreference = "Stop"

# 1) 若未以管理员运行,自动提权重启本脚本
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[start-agent] 当前非管理员,正在请求提权..." -ForegroundColor Yellow
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell.exe"
    $psi.Arguments = "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $psi.Verb = "RunAs"
    $psi.WorkingDirectory = $PSScriptRoot
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    exit 0
}

# 2) 定位脚本目录与二进制
$dir = $PSScriptRoot
$exe = Join-Path $dir "out\agent-windows-amd64.exe"
if (-not (Test-Path $exe)) { Write-Error "找不到 agent 二进制: $exe"; exit 1 }

# 3) 读取 agent.env(KEY=VALUE,支持 # 注释与空行)
$envFile = Join-Path $dir "agent.env"
$cfg = @{}
if (Test-Path $envFile) {
    foreach ($line in (Get-Content $envFile)) {
        $line = $line.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { continue }
        if ($line -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
            $cfg[$Matches[1]] = $Matches[2]
        }
    }
}

$SERVER = $cfg["SERVER"]
$ID     = $cfg["ID"]
$TOKEN  = $cfg["TOKEN"]
$SHELL  = $cfg["SHELL"]
$SSH    = $cfg["SSH_ADDR"]
$LOG    = $cfg["LOG"]

if (-not $SERVER -or -not $ID -or -not $TOKEN) {
    Write-Error "agent.env 中 SERVER/ID/TOKEN 未填写完整,请先编辑: $envFile"
    Write-Host "当前读取到 -> SERVER=[$SERVER] ID=[$ID] TOKEN=[$(if($TOKEN){'<已填>'}else{''})]" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

# 4) 组装参数
$args = @("--server", $SERVER, "--id", $ID, "--token", $TOKEN)
if ($SHELL) { $args += @("--shell", $SHELL) }
if ($SHELL -eq "ssh" -and $SSH) { $args += @("--ssh-addr", $SSH) }
if ($LOG) { $args += @("--log", $LOG) }

Write-Host "[start-agent] 以管理员身份启动 agent -> $exe" -ForegroundColor Green
Write-Host "[start-agent] 参数: --server $SERVER --id $ID --shell $(if($SHELL){$SHELL}else{'(默认 SSH 真终端,需本机已开启 OpenSSH.Server)'})" -ForegroundColor Cyan

# 5) 前台运行(CTRL+C 停止)
& $exe @args
