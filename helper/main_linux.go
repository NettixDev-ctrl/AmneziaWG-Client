//go:build linux

// awg-helper (Linux) — привилегированная часть Privata VPN.
//
//	awg-helper serve      запуск службы по требованию (через pkexec); слушает сокет /run/privata-vpn/helper.sock
//	awg-helper recover    аварийная очистка: туннель, kill switch, правила раздельного туннелирования
//	awg-helper version
package main

import (
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "version":
		fmt.Println(version)
	case "serve":
		if err := serve(os.Args[2:]); err != nil {
			fatal(err)
		}
	case "recover":
		if os.Geteuid() != 0 {
			fatal(errNotRoot)
		}
		m := NewManager()
		if r := m.Recover(); !r.OK {
			fatal(fmt.Errorf("%s", r.Error.Message))
		}
		fmt.Println("готово")
	default:
		usage()
	}
}

// clientUID определяет пользователя, которому принадлежит сокет: pkexec и sudo передают его в окружении.
func clientUID(args []string) (int, error) {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--uid" {
			n, err := strconv.Atoi(args[i+1])
			if err != nil || n < 0 {
				return 0, fmt.Errorf("неверный --uid")
			}
			return n, nil
		}
	}
	for _, k := range []string{"PKEXEC_UID", "SUDO_UID"} {
		if v := os.Getenv(k); v != "" {
			n, err := strconv.Atoi(v)
			if err == nil && n > 0 {
				return n, nil
			}
		}
	}
	return 0, fmt.Errorf("не удалось определить пользователя (запускайте через pkexec)")
}

func serve(args []string) error {
	if os.Geteuid() != 0 {
		return errNotRoot
	}
	uid, err := clientUID(args)
	if err != nil {
		return err
	}
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--awg-go" && strings.HasPrefix(args[i+1], "/") {
			awgGoImpl = args[i+1]
		}
	}
	m := NewManager()
	m.SweepOrphans() // после сбоя не должно оставаться туннелей, правил и файлов конфигурации
	srv, err := NewServer(m, uid)
	if err != nil {
		return err
	}
	m.logf("служба запущена для uid %d, версия %s", uid, version)
	go srv.Serve()
	go srv.IdleWatch(15 * time.Minute)

	sig := make(chan os.Signal, 2)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	select {
	case <-sig:
	case <-srv.Quit():
	}
	srv.Close()
	m.SweepOrphans() // при остановке службы туннель и правила не остаются
	m.logf("служба остановлена")
	return nil
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: awg-helper serve|recover|version")
	os.Exit(2)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "ошибка:", err)
	os.Exit(1)
}
