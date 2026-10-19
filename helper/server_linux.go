//go:build linux

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"sync/atomic"
	"time"

	"golang.org/x/sys/unix"
)

// Server принимает запросы приложения через Unix-сокет. Сокет принадлежит пользователю, запустившему
// службу (PKEXEC_UID), имеет права 0600, и каждое соединение дополнительно проверяется по SO_PEERCRED.
type Server struct {
	m       *Manager
	ln      *net.UnixListener
	uid     int
	last    atomic.Int64
	quit    chan struct{}
	stopped atomic.Bool
}

func NewServer(m *Manager, uid int) (*Server, error) {
	if err := os.MkdirAll(runDirPath, 0o755); err != nil {
		return nil, err
	}
	if c, err := net.DialTimeout("unix", sockPath, time.Second); err == nil {
		c.Close()
		return nil, errors.New("служба уже запущена")
	}
	_ = os.Remove(sockPath)
	old := unix.Umask(0o177)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sockPath, Net: "unix"})
	unix.Umask(old)
	if err != nil {
		return nil, err
	}
	if err := os.Chown(sockPath, uid, -1); err != nil {
		ln.Close()
		return nil, err
	}
	s := &Server{m: m, ln: ln, uid: uid, quit: make(chan struct{})}
	s.last.Store(time.Now().UnixNano())
	return s, nil
}

func (s *Server) Quit() <-chan struct{} { return s.quit }

func (s *Server) requestQuit() {
	if s.stopped.CompareAndSwap(false, true) {
		close(s.quit)
	}
}

func (s *Server) Close() {
	s.ln.Close()
	_ = os.Remove(sockPath)
}

// IdleWatch завершает службу, если туннель остановлен, а приложение не обращалось дольше idle.
func (s *Server) IdleWatch(idle time.Duration) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.quit:
			return
		case <-t.C:
			if s.m.Status().State == "stopped" && time.Since(time.Unix(0, s.last.Load())) > idle {
				s.requestQuit()
				return
			}
		}
	}
}

func (s *Server) Serve() {
	for {
		c, err := s.ln.AcceptUnix()
		if err != nil {
			return
		}
		go s.handle(c)
	}
}

func peerUID(c *net.UnixConn) (int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return -1, err
	}
	uid := -1
	var serr error
	if err := raw.Control(func(fd uintptr) {
		cred, e := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if e != nil {
			serr = e
			return
		}
		uid = int(cred.Uid)
	}); err != nil {
		return -1, err
	}
	return uid, serr
}

func (s *Server) handle(c *net.UnixConn) {
	defer c.Close()
	if uid, err := peerUID(c); err != nil || (uid != s.uid && uid != 0) {
		return
	}
	s.last.Store(time.Now().UnixNano())
	_ = c.SetDeadline(time.Now().Add(15 * time.Second))
	line, err := bufio.NewReaderSize(io.LimitReader(c, MaxRequestBytes+1), 4096).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return
	}
	if len(line) > MaxRequestBytes {
		writeResp(c, errResp("too-large", "Запрос слишком велик."))
		return
	}
	var req Request
	if err := json.Unmarshal(line, &req); err != nil {
		writeResp(c, errResp("bad-request", "Некорректный запрос."))
		return
	}
	writeResp(c, s.dispatch(&req))
}

func (s *Server) dispatch(req *Request) Response {
	v, err := Validate(req)
	if err != nil {
		return errResp("bad-request", err.Error())
	}
	switch req.Op {
	case OpHello:
		return Response{OK: true, Version: version, Status: s.m.Status()}
	case OpStatus:
		return Response{OK: true, Status: s.m.Status()}
	case OpConnect:
		return s.m.Connect(v)
	case OpDisconnect:
		return s.m.Disconnect()
	case OpRecover:
		return s.m.Recover()
	case OpLogs:
		return Response{OK: true, Logs: s.m.Logs(req.Tail)}
	case OpShutdown:
		r := s.m.Recover()
		go func() {
			time.Sleep(200 * time.Millisecond)
			s.requestQuit()
		}()
		return r
	}
	return errResp("bad-request", "Неизвестная операция.")
}

func writeResp(c net.Conn, r Response) {
	b, err := json.Marshal(r)
	if err != nil {
		return
	}
	_, _ = c.Write(append(b, '\n'))
}
