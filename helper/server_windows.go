//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

// Server принимает запросы приложения через именованный канал. Каждое соединение —
// один запрос и один ответ. Доступ к каналу ограничен DACL (SYSTEM, администраторы,
// интерактивные пользователи); удалённые клиенты отклоняются самой ОС.
type Server struct {
	m  *Manager
	ln net.Listener
}

func NewServer(m *Manager) (*Server, error) {
	ln, err := winio.ListenPipe(pipePath, &winio.PipeConfig{
		SecurityDescriptor: pipeSDDL,
		InputBufferSize:    MaxRequestBytes,
		OutputBufferSize:   MaxRequestBytes,
	})
	if err != nil {
		return nil, err
	}
	return &Server{m: m, ln: ln}, nil
}

func (s *Server) Serve() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("pipe accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go s.handle(c)
	}
}

func (s *Server) Close() { s.ln.Close() }

func (s *Server) handle(c net.Conn) {
	defer c.Close()
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
