//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

var payloadExt = map[string]bool{".exe": true, ".dll": true, ".sys": true, ".txt": true}

// cmdInstall регистрирует службу. Если исполняемый файл лежит не в Program Files (например,
// из portable-сборки), он вместе с wintun.dll и WinDivert копируется в защищённый каталог:
// службе с правами SYSTEM нельзя запускать файл из места, доступного на запись обычным пользователям.
func cmdInstall() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	target := exe
	if !isUnder(exe, programFilesDir()) {
		dst := filepath.Join(programFilesDir(), "Privata VPN", "helper")
		stopAndDeleteService(helperServiceName) // освобождаем файлы при обновлении
		if err := os.MkdirAll(dst, 0o755); err != nil {
			return fmt.Errorf("каталог %s: %w", dst, err)
		}
		entries, err := os.ReadDir(filepath.Dir(exe))
		if err != nil {
			return err
		}
		for _, e := range entries {
			if e.IsDir() || !payloadExt[strings.ToLower(filepath.Ext(e.Name()))] {
				continue
			}
			if err := copyFile(filepath.Join(filepath.Dir(exe), e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return fmt.Errorf("копирование %s: %w", e.Name(), err)
			}
		}
		target = filepath.Join(dst, filepath.Base(exe))
	}
	if err := ensureDataDirs(); err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	stopAndDeleteService(helperServiceName)
	s, err := m.CreateService(helperServiceName, target, mgr.Config{
		ServiceType:  windows.SERVICE_WIN32_OWN_PROCESS,
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
		DisplayName:  "Privata VPN: служба",
		Description:  "Управляет туннелем AmneziaWG и раздельным туннелированием для Privata VPN.",
	}, "service")
	if err != nil {
		return err
	}
	defer s.Close()
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 5 * time.Second}}, 86400)
	return s.Start()
}

func cmdUninstall() error {
	stopAndDeleteService(tunnelServiceName())
	stopAndDeleteService(helperServiceName)
	stopAndDeleteService("WinDivert") // драйвер WinDivert (если был загружен)
	_ = os.RemoveAll(dataDir())
	return nil
}

func stopAndDeleteService(name string) {
	m, err := mgr.Connect()
	if err != nil {
		return
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return
	}
	defer s.Close()
	if st, err := s.Query(); err == nil && st.State != svc.Stopped {
		s.Control(svc.Stop)
		for i := 0; i < 100; i++ {
			if st, err := s.Query(); err != nil || st.State == svc.Stopped {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	if err := s.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
		return
	}
	for i := 0; i < 40; i++ {
		s2, err := m.OpenService(name)
		if err != nil {
			return
		}
		s2.Close()
		time.Sleep(250 * time.Millisecond)
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
