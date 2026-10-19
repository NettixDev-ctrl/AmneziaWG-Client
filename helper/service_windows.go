//go:build windows

package main

import (
	"log"

	"golang.org/x/sys/windows/svc"
)

// helperService — служба Windows, под управлением которой работает сервер канала.
type helperService struct{}

func (helperService) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	setupLog()
	m := NewManager()
	m.SweepOrphans() // после сбоя/перезагрузки не должно оставаться туннелей и файлов конфигурации
	srv, err := NewServer(m)
	if err != nil {
		log.Printf("не удалось открыть канал: %v", err)
		return true, 1
	}
	go srv.Serve()
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	log.Printf("служба запущена, версия %s", version)
	for c := range r {
		switch c.Cmd {
		case svc.Interrogate:
			changes <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			srv.Close()
			m.SweepOrphans() // при остановке службы туннель и правила не остаются
			log.Printf("служба остановлена")
			return false, 0
		}
	}
	return false, 0
}

// runConsole — режим отладки (запуск из консоли от имени администратора).
func runConsole() error {
	setupLog()
	m := NewManager()
	m.SweepOrphans()
	srv, err := NewServer(m)
	if err != nil {
		return err
	}
	defer m.SweepOrphans()
	srv.Serve()
	return nil
}
