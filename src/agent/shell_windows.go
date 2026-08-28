//go:build windows

package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"sync"
)

// pipeSession 用普通 os/exec 管道桥接一个本地 shell(cmd.exe / powershell.exe)。
// 这是 Windows 上 SSH 真终端(sshd 不可用时)的保底实现:
//   - 不依赖 ConPTY(伪控制台句柄接线复杂、部分环境不稳定,已废弃该方案)。
//   - 提供"命令执行 + 输出回显"能力, 但不是完整交互式终端(无行编辑/提示符重绘/Ctrl 快捷键)。
//   - 写入 = 发送给 shell 的 stdin; 读取 = 来自 shell 的 stdout(已合并 stderr)。
type pipeSession struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	once   sync.Once
}

func (p *pipeSession) Read(b []byte) (int, error) {
	return p.stdout.Read(b)
}

func (p *pipeSession) Write(b []byte) (int, error) {
	return p.stdin.Write(b)
}

func (p *pipeSession) Close() error {
	p.once.Do(func() {
		_ = p.stdin.Close()
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
	})
	return nil
}

// buildShellCmd 根据 shell 名构造 *exec.Cmd, 并接好 stdin/stdout/stderr 管道。
//   - powershell/pwsh: 用 -Command - 从 stdin 逐行读命令执行(关闭配置文件加载)。
//   - cmd 及其它: 直接管道读命令执行。
// stdout 与 stderr 共享同一管道, 使浏览器端都能看到错误输出。
// 返回 cmd、stdin 写端、stdout 读端。
func buildShellCmd(shell string) (cmd *exec.Cmd, stdin io.WriteCloser, stdout io.ReadCloser, outW *os.File, err error) {
	lower := strings.ToLower(shell)
	switch {
	case strings.HasSuffix(lower, "powershell.exe"), strings.HasSuffix(lower, "pwsh.exe"):
		cmd = exec.Command(shell, "-NoProfile", "-NoLogo", "-Command", "-")
	default:
		// cmd.exe 及未知程序: 直接管道读命令执行
		cmd = exec.Command(shell)
	}

	// 输出管道: stdout 与 stderr 共享
	outR, outW, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("创建输出管道失败: %w", err)
	}
	cmd.Stdout = outW
	cmd.Stderr = outW

	stdin, err = cmd.StdinPipe()
	if err != nil {
		_ = outW.Close()
		_ = outR.Close()
		return nil, nil, nil, nil, fmt.Errorf("获取 stdin 管道失败: %w", err)
	}

	return cmd, stdin, outR, outW, nil
}

// startLocalShell 在本地起一个 shell。Windows 上不做 setuid
// (需 LogonUser, 后续可扩展), 但会校验用户名是否存在; 空白或 Linux 遗留的
// "root" 在 Windows 上视为"使用当前用户"(因为 Windows 无 root 账号且无法切换身份)。
//
// Windows 路由策略(用户决定: 直接装好 OpenSSH.Server 并开启 sshd, 用 SSH 真终端):
//   - shell 为空 或 "ssh" → 经本机 sshd 拿完整交互式 PTY(首选,真终端)。
//   - SSH 失败(如 sshd 未运行 / 凭据错误) → 自动回退普通管道 exec, 保证 shell 永不硬失败。
//   - "powershell" / "cmd" → 直接管道执行(非交互, 给不需要真终端的场景)。
func startLocalShell(ctx context.Context, m inMsg, shell string) (io.ReadWriteCloser, func(), error) {
	// Windows 首选 SSH 真终端: 经本机 sshd(OpenSSH.Server 提供)拿完整交互式 PTY。
	if shell == "" {
		shell = "ssh"
	}
	if strings.EqualFold(shell, "ssh") {
		sess, cl, e := startSSHShell(ctx, m)
		if e == nil {
			return sess, cl, nil
		}
		// 回退到本地管道(非交互), 让连接不至于失败
		log.Printf("SSH 真终端不可用, 回退普通管道 shell: %v", e)
		shell = defaultShell()
	}

	// 用户名校验: Windows 无法 setuid, 这里只做"存在性"门禁。
	// 空白 或 "root"(Linux 默认值, Windows 不存在) → 以当前用户(= agent 运行账号)运行。
	if m.Username != "" && !strings.EqualFold(m.Username, "root") {
		u, err := user.Lookup(m.Username)
		if err != nil || u == nil || u.HomeDir == "" {
			return nil, nil, fmt.Errorf("用户 %s 在服务器上不存在，拒绝起 shell", m.Username)
		}
		log.Printf("Windows: 用户 %s 存在，以当前用户起本地 shell: %s", m.Username, shell)
	} else {
		log.Printf("Windows: 以当前用户起本地 shell: %s", shell)
	}

	cmd, stdin, stdout, outW, err := buildShellCmd(shell)
	if err != nil {
		return nil, nil, fmt.Errorf("启动 shell(%s)失败: %w", shell, err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdout.Close()
		_ = outW.Close()
		_ = stdin.Close()
		return nil, nil, fmt.Errorf("启动 shell(%s)进程失败: %w", shell, err)
	}
	// 关闭父进程持有的输出写端副本: 子进程已继承其 fd, 关闭后子进程退出时读端能收到 EOF
	_ = outW.Close()

	sess := &pipeSession{cmd: cmd, stdin: stdin, stdout: stdout}
	cleanup := func() {
		_ = sess.Close()
		_ = stdout.Close()
	}
	return sess, cleanup, nil
}

// defaultShell 优先 powershell, 其次 pwsh, 最后 cmd。用 exec.LookPath 在 PATH 中查找。
func defaultShell() string {
	if _, err := exec.LookPath("powershell.exe"); err == nil {
		return "powershell.exe"
	}
	if _, err := exec.LookPath("pwsh.exe"); err == nil {
		return "pwsh.exe"
	}
	return "cmd.exe"
}

// resizeShell 普通管道无 PTY, 无法调整尺寸, 直接忽略;
// 若底层是 SSH 会话(真 PTY)则转发 WindowChange。
func resizeShell(f io.ReadWriteCloser, rows, cols int) error {
	if s, ok := f.(*sshSession); ok {
		return s.windowChange(uint16(rows), uint16(cols))
	}
	return nil
}
