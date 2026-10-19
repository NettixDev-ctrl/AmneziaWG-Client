//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	version           = "0.1.0"
	tunnelName        = "PrivataVPN" // имя адаптера и конфигурации; одновременно существует только один туннель
	helperServiceName = "PrivataVPNHelper"
	pipePath          = `\\.\pipe\PrivataVPN`
	// Доступ к каналу: SYSTEM и администраторы — полный, интерактивные пользователи — чтение/запись.
	pipeSDDL = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)"
	// Каталог данных доступен только SYSTEM и администраторам: в нём лежит конфигурация с секретами.
	dataDirSDDL = "O:SYG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
)

func dataDir() string {
	p, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, windows.KF_FLAG_DEFAULT)
	if err != nil {
		p = os.Getenv("ProgramData")
	}
	return filepath.Join(p, "PrivataVPN")
}

func runDir() string   { return filepath.Join(dataDir(), "run") }
func confPath() string { return filepath.Join(runDir(), tunnelName+".conf") }

func programFilesDir() string {
	p, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, windows.KF_FLAG_DEFAULT)
	if err != nil {
		return os.Getenv("ProgramFiles")
	}
	return p
}

// ensureSecureDir создаёт каталог (если нужно) и принудительно задаёт защищённый DACL.
func ensureSecureDir(path string) error {
	sd, err := windows.SecurityDescriptorFromString(dataDirSDDL)
	if err != nil {
		return err
	}
	p16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := &windows.SecurityAttributes{Length: uint32(sizeofSA), SecurityDescriptor: sd}
	if err := windows.CreateDirectory(p16, sa); err != nil && err != windows.ERROR_ALREADY_EXISTS {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

var sizeofSA = unsafe.Sizeof(windows.SecurityAttributes{})

func ensureDataDirs() error {
	for _, d := range []string{dataDir(), runDir()} {
		if err := ensureSecureDir(d); err != nil {
			return fmt.Errorf("каталог %s: %w", d, err)
		}
	}
	return nil
}

func isUnder(path, root string) bool {
	p := strings.ToLower(filepath.Clean(path))
	r := strings.ToLower(filepath.Clean(root))
	return p == r || strings.HasPrefix(p, r+string(os.PathSeparator))
}

// ---- журнал службы (без секретов: пишутся только события и коды) ----

var logOnce sync.Once

func setupLog() {
	logOnce.Do(func() {
		if err := ensureDataDirs(); err != nil {
			return
		}
		path := filepath.Join(dataDir(), "helper.log")
		if st, err := os.Stat(path); err == nil && st.Size() > 1<<20 {
			_ = os.Rename(path, path+".old")
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err == nil {
			log.SetOutput(f)
		}
		log.SetFlags(log.LstdFlags)
		log.SetPrefix("[helper] ")
	})
}
