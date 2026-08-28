//go:build windows

package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
)

// sshSession 把一条到本机 sshd 的 SSH 会话包装成 io.ReadWriteCloser,
// 供 openShell 的 pty↔WS 桥接复用。SSH 服务端会分配一个真正的 PTY,
// 因此浏览器端得到的是完整交互式终端(提示符/行编辑/方向键/Tab/Ctrl 全有),
// 这是普通管道 exec 做不到的。
type sshSession struct {
	client  *ssh.Client
	session *ssh.Session
	stdin   io.WriteCloser
	stdout  io.ReadCloser
	outW    *os.File
	once    sync.Once
}

func (s *sshSession) Read(b []byte) (int, error)  { return s.stdout.Read(b) }
func (s *sshSession) Write(b []byte) (int, error) { return s.stdin.Write(b) }
func (s *sshSession) Close() error {
	s.once.Do(func() {
		_ = s.session.Close()
		_ = s.client.Close()
		_ = s.outW.Close()
	})
	return nil
}

// resizeShell 在 shell_windows.go 中按类型分发; 这里处理 *sshSession。
func (s *sshSession) windowChange(rows, cols uint16) error {
	return s.session.WindowChange(int(rows), int(cols))
}

// startSSHShell 以 SSH 客户端身份连接本机 sshd(默认 127.0.0.1:22),
// 请求一个真 PTY, 然后起交互式 shell(powershell 优先, 回退 cmd),
// 把会话的 stdin/stdout 桥回 WebSocket。
//
// 认证: 连接消息里的 Username/Credential 直接作为 SSH 登录凭据——
//   - authType 为 "key"/"publickey": Credential 视为 PEM 私钥。
//   - 其它(含空): Credential 视为密码。
//
// 注意: 目标固定为本机回环地址, HostKey 用 InsecureIgnoreHostKey 跳过校验
// (仅限 127.0.0.1, 不会被中间人, 生产若需严格校验可改为 known_hosts)。
func startSSHShell(ctx context.Context, m inMsg) (io.ReadWriteCloser, func(), error) {
	if m.Username == "" {
		return nil, nil, fmt.Errorf("SSH 模式需要填写登录用户名(如 Administrator)")
	}

	addr := *sshAddr
	var auth []ssh.AuthMethod
	switch strings.ToLower(m.AuthType) {
	case "key", "publickey":
		signer, err := ssh.ParsePrivateKey([]byte(m.Credential))
		if err != nil {
			return nil, nil, fmt.Errorf("解析 SSH 私钥失败: %w", err)
		}
		auth = append(auth, ssh.PublicKeys(signer))
	default:
		auth = append(auth, ssh.Password(m.Credential))
	}

	config := &ssh.ClientConfig{
		User:            m.Username,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}

	log.Printf("SSH 桥接: 连接 %s (用户 %s)", addr, m.Username)
	client, err := ssh.Dial("tcp", addr, config)
	if err != nil {
		return nil, nil, fmt.Errorf("连接 sshd(%s)失败: %w", addr, err)
	}

	session, err := client.NewSession()
	if err != nil {
		_ = client.Close()
		return nil, nil, fmt.Errorf("创建 SSH 会话失败: %w", err)
	}

	rows, cols := uint16(m.Rows), uint16(m.Cols)
	if rows <= 0 {
		rows = 24
	}
	if cols <= 0 {
		cols = 80
	}
	if err := session.RequestPty("xterm-256color", int(rows), int(cols), ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}); err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, nil, fmt.Errorf("请求 PTY 失败: %w", err)
	}

	// stdout 与 stderr 共享同一管道, 浏览器端都能看到
	outR, outW, err := os.Pipe()
	if err != nil {
		_ = session.Close()
		_ = client.Close()
		return nil, nil, fmt.Errorf("创建输出管道失败: %w", err)
	}
	session.Stdout = outW
	session.Stderr = outW

	stdin, err := session.StdinPipe()
	if err != nil {
		_ = outW.Close()
		_ = outR.Close()
		_ = session.Close()
		_ = client.Close()
		return nil, nil, fmt.Errorf("获取 stdin 管道失败: %w", err)
	}

	// 起交互式 shell: powershell 优先(更现代的终端体验), 回退 cmd
	shellCmd := "cmd.exe"
	if _, lerr := exec.LookPath("powershell.exe"); lerr == nil {
		shellCmd = "powershell.exe -NoProfile -NoLogo"
	}
	if err := session.Start(shellCmd); err != nil {
		_ = outW.Close()
		_ = outR.Close()
		_ = stdin.Close()
		_ = session.Close()
		_ = client.Close()
		return nil, nil, fmt.Errorf("启动 shell(%s)失败: %w", shellCmd, err)
	}

	sess := &sshSession{client: client, session: session, stdin: stdin, stdout: outR, outW: outW}
	cleanup := func() {
		_ = sess.Close()
	}
	return sess, cleanup, nil
}
