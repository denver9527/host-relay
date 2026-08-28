// host-relay agent — 常驻客户端(M1+M2 状态上报 + M3 网页 shell 终结,方案 B)
// 无界面,命令行运行。方案 B:agent 不再 dial 主机 sshd,而是本地 setuid+exec 起 shell,
// 经 WS(443) 隧道双向桥接。零端口、不碰 PAM、权限边界在 relay。
//
// 用法:
//   agent --server wss://host-relay.example.com --id h_xxxx --token tk_xxxx \
//         --shell /bin/bash --interval 30s
//   用户名在网页端指定(agent 以 root 运行时可 setuid 降权到该用户)。

package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
)

const version = "1.0.5"

var (
	server    = flag.String("server", "", "服务端地址,如 wss://host-relay.example.com(必填)")
	hostID    = flag.String("id", "", "面板分配的主机 ID(必填)")
	token     = flag.String("token", "", "面板生成的令牌(必填)")
	shellPath = flag.String("shell", "", "本地 shell 路径(方案 B:agent 直接起此 shell,默认按 OS 选 /bin/bash 或 powershell)")
	sshAddr   = flag.String("ssh-addr", "127.0.0.1:22", "SSH 桥接模式连接地址(默认本机 sshd);Windows 默认走 SSH,故该地址总生效")
	interval  = flag.Duration("interval", 30*time.Second, "状态上报间隔")
	diskPath  = flag.String("disk-path", defaultDiskPath(), "磁盘用量统计路径")
	logFile   = flag.String("log", "", "指定日志文件路径,不指定则默认不保存日志文件")
)

func defaultDiskPath() string {
	if runtime.GOOS == "windows" {
		return "C:\\"
	}
	return "/"
}

type outMsg struct {
	Type      string  `json:"type"`
	HostID    string  `json:"hostId,omitempty"`
	Token     string  `json:"token,omitempty"`
	OS        string  `json:"os,omitempty"`
	Arch      string  `json:"arch,omitempty"`
	Version   string  `json:"version,omitempty"`
	Hostname  string  `json:"hostname,omitempty"`
	Platform  string  `json:"platform,omitempty"`
	TS        int64   `json:"ts,omitempty"`
	CPU       float64 `json:"cpu"`
	MemUsed   uint64  `json:"memUsed,omitempty"`
	MemTotal  uint64  `json:"memTotal,omitempty"`
	DiskUsed  uint64  `json:"diskUsed,omitempty"`
	DiskTotal uint64  `json:"diskTotal,omitempty"`
	Uptime    uint64  `json:"uptime,omitempty"`
	Load1     float64 `json:"load1"`
	PublicIP  string  `json:"publicIp,omitempty"`
	LocalIPs  []string `json:"localIps,omitempty"`
	ChannelID uint16  `json:"channelId,omitempty"`
	Msg       string  `json:"msg,omitempty"`
}

type inMsg struct {
	Type       string `json:"type"`
	Msg        string `json:"msg"`
	ChannelID  uint16 `json:"channelId"`
	Username   string `json:"username"`
	AuthType   string `json:"authType"`
	Credential string `json:"credential"`
	Shell      string `json:"shell"` // 起 shell 方式: 空/ powershell / cmd / ssh(Windows 默认走 ssh 经本机 sshd 拿真 PTY)
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
}

// sshChan 表示一个网页终端会话(方案 B:本地 shell 经 PTY 桥接)
type sshChan struct {
	pty    io.ReadWriteCloser
	cancel context.CancelFunc
}

type conn struct {
	ws    *websocket.Conn
	mu    sync.Mutex
	cmu   sync.Mutex
	chans map[uint16]*sshChan
}

func (c *conn) writeJSON(v interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ws.WriteJSON(v)
}

func (c *conn) writeBinary(cid uint16, payload []byte) {
	frame := make([]byte, 3+len(payload))
	frame[0] = 1
	frame[1] = byte(cid >> 8)
	frame[2] = byte(cid)
	copy(frame[3:], payload)
	c.mu.Lock()
	_ = c.ws.WriteMessage(websocket.BinaryMessage, frame)
	c.mu.Unlock()
}

func (c *conn) writePing() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
}

func main() {
	flag.Parse()
	if *logFile != "" {
		f, err := os.OpenFile(*logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			log.Fatalf("无法打开日志文件 %s: %v", *logFile, err)
		}
		defer f.Close()
		log.SetOutput(io.MultiWriter(os.Stdout, f))
	}
	startAgent()
}

func startAgent() {
	if *server == "" || *hostID == "" || *token == "" {
		log.Fatal("缺少必填参数:--server / --id / --token")
	}
	u, err := url.Parse(*server)
	if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") {
		log.Fatalf("server 地址非法,应以 ws:// 或 wss:// 开头: %v", err)
	}
	u.Path = "/ws/agent"
	u.RawQuery = "id=" + url.QueryEscape(*hostID)

	hostname, _ := os.Hostname()
	log.Printf("host-relay agent v%s 启动,目标 %s(主机 %s,方案B:本地 shell 经 WS 桥接)", version, u.String(), *hostID)
	_, _ = cpu.Percent(0, false)

	backoff := time.Second
	for {
		if err := runOnce(u.String(), hostname); err != nil {
			log.Printf("连接结束: %v;%.0fs 后重连", err, backoff.Seconds())
		}
		time.Sleep(backoff)
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func runOnce(wsURL, hostname string) error {
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	defer ws.Close()
	c := &conn{ws: ws, chans: map[uint16]*sshChan{}}
	defer c.closeAllChans()

	if err := c.writeJSON(outMsg{
		Type: "register", HostID: *hostID, Token: *token,
		OS: runtime.GOOS, Arch: runtime.GOARCH, Version: version, Hostname: hostname,
	}); err != nil {
		return err
	}

	done := make(chan error, 1)

	go func() {
		first := true
		for {
			mt, data, err := ws.ReadMessage()
			if err != nil {
				done <- err
				return
			}
			if mt == websocket.BinaryMessage {
				c.routeBinary(data)
				continue
			}
			var m inMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			if first {
				first = false
				if m.Type == "registered" {
					done <- nil
				} else {
					done <- &authErr{m.Msg}
					return
				}
				continue
			}
			c.handleMessage(m)
		}
	}()

	select {
	case err := <-done:
		if err != nil {
			return err
		}
	case <-time.After(10 * time.Second):
		return &authErr{"注册超时"}
	}
	log.Printf("已注册,开始上报(每 %s)", interval.String())

	pingT := time.NewTicker(30 * time.Second)
	defer pingT.Stop()
	statusT := time.NewTicker(*interval)
	defer statusT.Stop()

	u, _ := url.Parse(wsURL)
	reportStatus(c, hostname, u.Scheme, u.Host)

	for {
		select {
		case <-pingT.C:
			if err := c.writePing(); err != nil {
				return err
			}
		case <-statusT.C:
			reportStatus(c, hostname, u.Scheme, u.Host)
		case err := <-done:
			return err
		}
	}
}

func reportStatus(c *conn, hostname, scheme, host string) {
	if err := c.writeJSON(collectStatus(hostname, scheme, host)); err != nil {
		log.Printf("上报失败: %v", err)
	}
}

func collectStatus(hostname, scheme, hostAddr string) outMsg {
	m := outMsg{Type: "status", TS: time.Now().UnixMilli(), Hostname: hostname}
	if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
		m.CPU = pcts[0]
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		m.MemUsed, m.MemTotal = vm.Used, vm.Total
	}
	if du, err := disk.Usage(*diskPath); err == nil {
		m.DiskUsed, m.DiskTotal = du.Used, du.Total
	}
	if hi, err := host.Info(); err == nil {
		m.Uptime = hi.Uptime
		m.Platform = hi.Platform
		if hi.PlatformVersion != "" {
			m.Platform = hi.Platform + " " + hi.PlatformVersion
		}
	}
	if runtime.GOOS != "windows" {
		if la, err := load.Avg(); err == nil {
			m.Load1 = la.Load1
		}
	}
	m.PublicIP = getPublicIP(scheme, hostAddr)
	m.LocalIPs = getLocalIPs()
	return m
}

var (
	publicIPCache string
	publicIPAt    time.Time
	publicIPMu    sync.Mutex
)

func getPublicIP(scheme, host string) string {
	publicIPMu.Lock()
	defer publicIPMu.Unlock()
	// 缓存 5 分钟:状态每 30s 上报一次,避免每次上报都阻塞在 /api/ip 请求上
	if publicIPCache != "" && time.Since(publicIPAt) < 5*time.Minute {
		return publicIPCache
	}
	httpScheme := "http"
	if scheme == "wss" || scheme == "https" {
		httpScheme = "https"
	}
	apiURL := httpScheme + "://" + host + "/api/ip"
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(apiURL)
	if err != nil {
		return "" // 失败不写缓存,下次上报再试
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 {
		ip, _ := io.ReadAll(resp.Body)
		publicIPCache = string(ip)
		publicIPAt = time.Now()
		return publicIPCache
	}
	return ""
}

func getLocalIPs() []string {
	var ips []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ips
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				ips = append(ips, ipnet.IP.String())
			}
		}
	}
	return ips
}

// ----------------- 消息分发 -----------------
func (c *conn) handleMessage(m inMsg) {
	switch m.Type {
	case "ssh_open":
		go c.openShell(m)
	case "resize":
		c.cmu.Lock()
		ch := c.chans[m.ChannelID]
		c.cmu.Unlock()
		if ch != nil && ch.pty != nil {
			_ = resizeShell(ch.pty, m.Rows, m.Cols)
		}
	case "ssh_close":
		c.closeChan(m.ChannelID)
	}
}

func (c *conn) routeBinary(data []byte) {
	if len(data) < 3 || data[0] != 1 {
		return
	}
	cid := uint16(data[1])<<8 | uint16(data[2])
	c.cmu.Lock()
	ch := c.chans[cid]
	c.cmu.Unlock()
	if ch != nil && ch.pty != nil {
		if _, err := ch.pty.Write(data[3:]); err != nil {
			log.Printf("channel %d 写入 shell 失败(会话可能已结束): %v", cid, err)
		}
	}
}

// ----------------- 本地 shell 终结(方案 B) -----------------
func (c *conn) openShell(m inMsg) {
	ctx, cancel := context.WithCancel(context.Background())
	// 不再 defer cancel:openShell 写完 ssh_opened 启动两个 goroutine 后主线程就 return,
	// defer 会立刻把 ctx 干掉,导致下面监听 ctx.Done() 的 goroutine 误判 shell 结束,
	// 浏览器在 ssh_opened 之后立刻看到 ssh_close "shell 已结束"。
	// ctx 的生命周期由 closeChan()(用户主动关)/ closeAllChans()(ws 断开)显式管理。
	defer cancel() // 仍保留 defer:函数异常 return(比如 startLocalShell 失败)时回收 ctx;成功路径下主线程会 wait 在 ctx.Done() 上,defer 不会提前触发
	_ = cancel

	sendErr := func(msg string) {
		_ = c.writeJSON(outMsg{Type: "ssh_error", ChannelID: m.ChannelID, Msg: msg})
	}

	// shell 选择优先级: 连接消息里的 m.Shell(前端下拉) > --shell 启动参数 > 按 OS 默认。
	// Windows 默认走 "ssh"(经本机 OpenSSH.Server 的 sshd 拿真 PTY);
	// 可选 "powershell" / "cmd"(普通管道,非交互); Linux 默认 /bin/bash。
	shellChoice := m.Shell
	if shellChoice == "" {
		shellChoice = *shellPath
	}
	ptyFile, cleanup, err := startLocalShell(ctx, m, shellChoice)
	if err != nil {
		sendErr(friendlyShellError("启动 shell", err))
		return
	}

	c.cmu.Lock()
	c.chans[m.ChannelID] = &sshChan{pty: ptyFile, cancel: cancel}
	c.cmu.Unlock()

	_ = c.writeJSON(outMsg{Type: "ssh_opened", ChannelID: m.ChannelID})

	// pty → WS(浏览器渲染)
	go func() {
		buf := make([]byte, 32*1024)
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			n, rerr := ptyFile.Read(buf)
			if n > 0 {
				c.writeBinary(m.ChannelID, buf[:n])
			}
			if rerr != nil {
				// shell 进程退出 / pty 关闭 → 唤醒主线程,让 openShell 收尾
				cancel()
				return
			}
		}
	}()

	// shell 退出 / 被取消后清理
	go func() {
		<-ctx.Done()
		cleanup()
		c.cmu.Lock()
		delete(c.chans, m.ChannelID)
		c.cmu.Unlock()
		log.Printf("channel %d shell 已结束,关闭 WS 通知浏览器", m.ChannelID)
		_ = c.writeJSON(outMsg{Type: "ssh_close", ChannelID: m.ChannelID, Msg: "shell 已结束"})
	}()

	// 主线程阻塞在 ctx.Done() 上,直到 closeChan / closeAllChans / pty 真正退出才 cancel。
	// 这是修复"会话已结束"的关键:openShell 不能再 writeJSON ssh_opened 之后立即 return。
	<-ctx.Done()
}

func (c *conn) closeChan(cid uint16) {
	c.cmu.Lock()
	ch := c.chans[cid]
	delete(c.chans, cid)
	c.cmu.Unlock()
	if ch != nil && ch.cancel != nil {
		// 通知 openShell 的 ctx.Done 分支执行 cleanup 并回收进程
		ch.cancel()
	}
}

func (c *conn) closeAllChans() {
	c.cmu.Lock()
	chans := c.chans
	c.chans = map[uint16]*sshChan{}
	c.cmu.Unlock()
	for _, ch := range chans {
		if ch.cancel != nil {
			ch.cancel()
		}
	}
}

// friendlyShellError 把底层错误翻译成中文可读提示
func friendlyShellError(phase string, err error) string {
	if err == nil {
		return phase + "失败"
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "permission denied"):
		return "权限不足:无法以该用户身份起 shell(agent 需以 root 运行才能 setuid 到该用户)"
	case strings.Contains(msg, "no such file"), strings.Contains(msg, "exec"):
		return "启动 shell 失败:指定的 shell 路径不存在或无法执行(" + msg + ")"
	case strings.Contains(msg, "signal"), strings.Contains(msg, "killed"):
		return "shell 进程已被终止"
	default:
		return phase + "失败:" + msg
	}
}

type authErr struct{ s string }

func (e *authErr) Error() string {
	if e.s == "" {
		return "注册被拒绝"
	}
	return "注册被拒绝: " + e.s
}
