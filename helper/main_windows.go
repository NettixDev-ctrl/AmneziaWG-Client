//go:build windows

// awg-helper — привилегированная часть Privata VPN.
//
//	awg-helper service            запуск как служба Windows (регистрируется командой install)
//	awg-helper run                запуск из консоли (отладка, от имени администратора)
//	awg-helper install|uninstall  регистрация/удаление службы (нужны права администратора)
//	awg-helper /tunnelservice P   служба туннеля; запускается только менеджером
//	awg-helper version
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/svc"

	"github.com/amnezia-vpn/amneziawg-windows/v3/conf"
	"github.com/amnezia-vpn/amneziawg-windows/v3/tunnel"
)

func main() {
	// Все компоненты библиотеки AmneziaWG (журнал, каталоги) работают в каталоге данных Privata.
	conf.PresetRootDirectory(dataDir())

	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "version":
		fmt.Println(version)
	case "service":
		if ok, _ := svc.IsWindowsService(); !ok {
			fatal(fmt.Errorf("команда service запускается только менеджером служб Windows; для отладки используйте run"))
		}
		err = svc.Run(helperServiceName, helperService{})
	case "run":
		err = runConsole()
	case "install":
		err = cmdInstall()
	case "uninstall":
		err = cmdUninstall()
	case "/tunnelservice":
		if len(os.Args) != 3 {
			usage()
		}
		err = runTunnelService(os.Args[2])
	default:
		usage()
	}
	if err != nil {
		fatal(err)
	}
}

// runTunnelService запускает штатную службу туннеля amneziawg-windows. Принимается только
// конфигурация из защищённого каталога данных: путь, подсунутый снаружи, отвергается.
func runTunnelService(path string) error {
	clean := filepath.Clean(path)
	if !strings.EqualFold(clean, confPath()) {
		return fmt.Errorf("недопустимый путь конфигурации")
	}
	return tunnel.Run(clean)
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: awg-helper service|run|install|uninstall|version")
	os.Exit(2)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "ошибка:", err)
	os.Exit(1)
}
