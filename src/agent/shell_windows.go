//go:build windows

package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"

	"github.com/creack/pty"
)

// startLocalShell 在本地起一个 shell。Windows 下优先用 ConPTY(creack/pty,Win10+),
// 不可用时回退普通管道桥接(无完整 PTY 语义)。Windows 暂不 setuid(需 LogonUser,后续扩展),
// 以当前用户身份起 shell。
func startLocalShell(ctx context.Context, m inMsg, shell string) (io.ReadWriteCloser, func(), error) {
	if shell == "" {
		shell = defaultShell()
	}
	cmd := exec.CommandContext(ctx, shell)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")

	log.Printf("Windows: 以当前用户起本地 shell: %s", shell)

	rows, cols := m.Rows, m.Cols
	if rows <= 0 {
		rows = 24
	}
	if cols <= 0 {
		cols = 80
	}

	// 尝试 ConPTY(creack/pty 在 Win10+ 支持)
	ptyFile, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		log.Printf("ConPTY 不可用,回退普通管道: %v", err)
		stdin, e1 := cmd.StdinPipe()
		stdout, e2 := cmd.StdoutPipe()
		if e1 != nil || e2 != nil {
			return nil, nil, fmt.Errorf("启动 shell(%s)失败: %v / %v", shell, e1, e2)
		}
		cmd.Stderr = cmd.Stdout
		if e3 := cmd.Start(); e3 != nil {
			return nil, nil, fmt.Errorf("启动 shell(%s)失败: %w", shell, e3)
		}
		rwc := &pipeRW{stdout: stdout, stdin: stdin, cmd: cmd}
		cleanup := func() {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			_ = stdout.Close()
			_ = stdin.Close()
		}
		return rwc, cleanup, nil
	}

	cleanup := func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = ptyFile.Close()
	}
	return ptyFile, cleanup, nil
}

// pipeRW 把普通 stdio pipe 组合成 ReadWriteCloser(无 PTY 语义,仅作回退)
type pipeRW struct {
	stdout io.ReadCloser
	stdin  io.WriteCloser
	cmd    *exec.Cmd
}

func (p *pipeRW) Read(b []byte) (int, error)  { return p.stdout.Read(b) }
func (p *pipeRW) Write(b []byte) (int, error) { return p.stdin.Write(b) }
func (p *pipeRW) Close() error {
	_ = p.stdin.Close()
	_ = p.stdout.Close()
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	return nil
}

func defaultShell() string {
	for _, s := range []string{"powershell.exe", "cmd.exe"} {
		if _, err := os.Stat(s); err == nil {
			return s
		}
	}
	return "cmd.exe"
}

func resizeShell(f io.ReadWriteCloser, rows, cols int) error {
	if p, ok := f.(*os.File); ok {
		// Windows ConPTY 的 Setsize 可能不被支持,忽略错误
		_ = pty.Setsize(p, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	}
	return nil
}
