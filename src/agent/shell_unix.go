//go:build linux || darwin

package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strconv"
	"syscall"

	"github.com/creack/pty"
)

// startLocalShell 在本地起一个交互式 shell(经 PTY)。
// username 用于 setuid 降权(需 agent 以 root 运行);无法解析或无权则回退当前用户。
// 返回的 io.ReadWriteCloser 即 pty 主端,cleanup 负责回收进程。
func startLocalShell(ctx context.Context, m inMsg, shell string) (io.ReadWriteCloser, func(), error) {
	if shell == "" {
		shell = defaultShell()
	}
	cmd := exec.CommandContext(ctx, shell, "-i")
	baseEnv := []string{"TERM=xterm-256color"}

	if uid, gid, home, ok := lookupUser(m.Username); ok {
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{Uid: uid, Gid: gid},
			Setsid:     true,
		}
		// 降权后注入目标用户的 HOME/USER/SHELL,避免以目标用户身份却读到 /root 的 dotfiles(Permission denied)
		baseEnv = append(baseEnv, "HOME="+home, "USER="+m.Username, "SHELL="+shell)
		log.Printf("以用户 %s(uid=%d,home=%s) 起本地 shell: %s", m.Username, uid, home, shell)
	} else {
		return nil, nil, fmt.Errorf("用户 %s 在服务器上不存在，拒绝起 shell", m.Username)
	}
	cmd.Env = baseEnv

	rows, cols := m.Rows, m.Cols
	if rows <= 0 {
		rows = 24
	}
	if cols <= 0 {
		cols = 80
	}

	ptyFile, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		return nil, nil, fmt.Errorf("启动 shell(%s)失败: %w", shell, err)
	}

	cleanup := func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = ptyFile.Close()
	}
	return ptyFile, cleanup, nil
}

func defaultShell() string {
	if runtime.GOOS == "darwin" {
		return "/bin/bash"
	}
	for _, s := range []string{"/bin/bash", "/bin/zsh", "/bin/sh"} {
		if _, err := os.Stat(s); err == nil {
			return s
		}
	}
	return "/bin/sh"
}

func lookupUser(name string) (uint32, uint32, string, bool) {
	if name == "" {
		return 0, 0, "", false
	}
	u, err := user.Lookup(name)
	if err != nil {
		return 0, 0, "", false
	}
	uid, err1 := strconv.ParseUint(u.Uid, 10, 32)
	gid, err2 := strconv.ParseUint(u.Gid, 10, 32)
	if err1 != nil || err2 != nil {
		return 0, 0, "", false
	}
	home := u.HomeDir
	if home == "" {
		home = "/"
	}
	return uint32(uid), uint32(gid), home, true
}

func resizeShell(f io.ReadWriteCloser, rows, cols int) error {
	if p, ok := f.(*os.File); ok {
		return pty.Setsize(p, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	}
	return nil
}
