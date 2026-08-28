//go:build windows

package main

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestPipeShell_PowerShellEcho 验证普通管道桥接能真正执行命令并回显输出。
func TestPipeShell_PowerShellEcho(t *testing.T) {
	sess, cleanup, err := startLocalShell(context.Background(), inMsg{Username: ""}, "cmd.exe")
	if err != nil {
		t.Fatalf("启动 shell 失败: %v", err)
	}
	defer cleanup()

	marker := "PIPE_OK_" + time.Now().Format("150405")
	go func() {
		time.Sleep(300 * time.Millisecond)
		_, _ = sess.Write([]byte("echo " + marker + "\r\n"))
	}()

	got := readWithTimeoutTest(t, sess, 5*time.Second, marker)
	if !strings.Contains(got, marker) {
		t.Fatalf("未在输出中看到 %s, 实际输出:\n%s", marker, got)
	}
	t.Logf("管道 shell 回显正常: 看到 %s", marker)
}

// readWithTimeoutTest 在 d 内从 sess 收集输出, 直到看到 want 或超时。
func readWithTimeoutTest(t *testing.T, sess interface{ Read([]byte) (int, error) }, d time.Duration, want string) string {
	type reader = interface{ Read([]byte) (int, error) }
	_ = reader(nil)
	r := sess
	ch := make(chan []byte, 64)
	var mu sync.Mutex
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				b := make([]byte, n)
				copy(b, buf[:n])
				ch <- b
			}
			if err != nil {
				return
			}
		}
	}()
	var out []byte
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		select {
		case b := <-ch:
			mu.Lock()
			out = append(out, b...)
			mu.Unlock()
			if strings.Contains(string(out), want) {
				return string(out)
			}
		case <-time.After(100 * time.Millisecond):
		}
	}
	mu.Lock()
	defer mu.Unlock()
	return string(out)
}
