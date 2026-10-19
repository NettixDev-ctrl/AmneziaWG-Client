//go:build windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/amnezia-vpn/amneziawg-windows/v3/conf"
	"github.com/amnezia-vpn/amneziawg-windows/v3/ringlogger"
	"github.com/amnezia-vpn/amneziawg-windows/v3/services"

	"github.com/privata/awg-client/helper/split"
)

// Manager управляет единственным туннелем: запускает штатную службу туннеля amneziawg-windows
// (она создаёт адаптер Wintun, маршруты, DNS, правила брандмауэра и обрабатывает AWG 3.x),
// отслеживает её состояние и рукопожатие и запускает движок раздельного туннелирования.
type Manager struct {
	mu sync.Mutex
	st managerState

	opMu sync.Mutex // сериализует connect/disconnect/recover
	stop chan struct{}

	engine *split.Engine
}

type managerState struct {
	state     string // stopped | starting | running | stopping | failed
	errCode   string
	errMsg    string
	staleSec  int
	rx, tx    uint64
	hsAge     *float64
	splitMode split.Mode
	splitApps []string
	endpoint  *[4]byte
	splitSt   string // off | starting | running | failed
	splitErr  string
	flows     int
	startedAt time.Time
}

func NewManager() *Manager {
	return &Manager{st: managerState{state: "stopped", splitSt: "off"}}
}

func (m *Manager) Status() *Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := &Status{State: m.st.state, HandshakeAgeSec: m.st.hsAge, RxBytes: m.st.rx, TxBytes: m.st.tx,
		Split: SplitStatus{State: m.st.splitSt, ActiveFlows: m.st.flows}}
	if m.st.errCode != "" {
		c, e := m.st.errCode, m.st.errMsg
		s.ErrorCode, s.Error = &c, &e
	}
	if m.st.splitErr != "" {
		e := m.st.splitErr
		s.Split.Error = &e
	}
	return s
}

func (m *Manager) set(f func(s *managerState)) {
	m.mu.Lock()
	f(&m.st)
	m.mu.Unlock()
}

// Connect проверяет конфигурацию и запускает подключение в фоне; результат виден через Status.
func (m *Manager) Connect(v *ValidatedConnect) Response {
	// Окончательная проверка — разбор самой библиотеки AmneziaWG (знает все параметры AWG 3.x).
	cfg, err := conf.FromWgQuickWithUnknownEncoding(v.Config, tunnelName)
	if err != nil {
		return errResp("bad-config", "Конфигурация отклонена: "+sanitizeErr(err))
	}
	if cfg.Interface.PreUp != "" || cfg.Interface.PostUp != "" || cfg.Interface.PreDown != "" || cfg.Interface.PostDown != "" {
		return errResp("scripts-not-allowed", "Скрипты в конфигурации не поддерживаются.")
	}
	if len(cfg.Peers) != 1 {
		return errResp("bad-config", "Поддерживается ровно один сервер ([Peer]).")
	}

	if !m.opMu.TryLock() {
		return errResp("busy", "Выполняется другая операция, повторите через несколько секунд.")
	}
	m.mu.Lock()
	busy := m.st.state == "stopping"
	m.mu.Unlock()
	if busy {
		m.opMu.Unlock()
		return errResp("busy", "Туннель ещё останавливается.")
	}

	var endpoint *[4]byte
	if h := cfg.Peers[0].Endpoint.Host; h != "" {
		endpoint = resolveV4(h)
	}
	m.set(func(s *managerState) {
		*s = managerState{state: "starting", staleSec: v.StaleAfterSec, splitMode: v.SplitMode, splitApps: v.SplitApps,
			endpoint: endpoint, splitSt: "off", startedAt: time.Now()}
	})
	go func() {
		defer m.opMu.Unlock()
		m.runConnect(v.Config)
	}()
	return Response{OK: true, Status: m.Status()}
}

func (m *Manager) runConnect(config string) {
	fail := func(code, msg string) {
		log.Printf("connect failed: %s", code)
		m.teardownLocked()
		m.set(func(s *managerState) { s.state, s.errCode, s.errMsg = "failed", code, msg })
	}
	// Прежний туннель (если остался) удаляется до создания нового: конфликтующих сессий не бывает.
	m.teardownLocked()
	m.set(func(s *managerState) { s.state, s.errCode, s.errMsg = "starting", "", "" })

	if err := ensureDataDirs(); err != nil {
		fail("data-dir", "Не удалось подготовить каталог данных службы.")
		return
	}
	if err := writeSecretFile(confPath(), []byte(config)); err != nil {
		fail("write-config", "Не удалось сохранить конфигурацию для службы туннеля.")
		return
	}
	if err := installTunnelService(confPath()); err != nil {
		log.Printf("installTunnelService: %v", err)
		fail("install-service", "Не удалось запустить службу туннеля: "+sanitizeErr(err))
		return
	}

	stop := make(chan struct{})
	m.mu.Lock()
	m.stop = stop
	m.mu.Unlock()
	go m.monitor(stop)
}

// monitor раз в секунду опрашивает SCM и канал управления туннеля.
func (m *Manager) monitor(stop chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	engineTries := 0
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		svcState, exitCode, err := queryTunnelService()
		if err != nil {
			continue
		}
		if svcState == svc.Stopped {
			code, msg := describeExit(exitCode)
			log.Printf("tunnel service stopped unexpectedly: %s", code)
			go func() {
				m.opMu.Lock()
				defer m.opMu.Unlock()
				m.mu.Lock()
				still := m.stop == stop
				m.mu.Unlock()
				if !still {
					return
				}
				m.teardownLocked()
				m.set(func(s *managerState) { s.state, s.errCode, s.errMsg = "failed", code, msg })
			}()
			return
		}
		if svcState != svc.Running {
			continue
		}
		stats, err := queryTunnel()
		m.mu.Lock()
		if err == nil {
			m.st.rx, m.st.tx = stats.Rx, stats.Tx
			if stats.LastHandshake.IsZero() {
				m.st.hsAge = nil
			} else {
				a := time.Since(stats.LastHandshake).Seconds()
				if a < 0 {
					a = 0
				}
				m.st.hsAge = &a
			}
		}
		if m.st.state == "starting" {
			m.st.state = "running"
		}
		needEngine := m.st.splitMode != split.ModeAll && m.engine == nil && m.st.splitSt != "failed"
		mode, apps, ep := m.st.splitMode, m.st.splitApps, m.st.endpoint
		m.mu.Unlock()

		if needEngine {
			engineTries++
			m.startEngine(mode, apps, ep, engineTries >= 20)
		}
		m.refreshEngine()
	}
}

func (m *Manager) startEngine(mode split.Mode, apps []string, ep *[4]byte, final bool) {
	m.set(func(s *managerState) { s.splitSt = "starting" })
	exe, _ := os.Executable()
	eng, err := split.Start(split.Params{
		Mode: mode, Apps: apps, TunName: tunnelName, EndpointIP: ep,
		DLLPath: filepath.Join(filepath.Dir(exe), "WinDivert.dll"),
		Logf:    func(f string, a ...any) { log.Printf(f, a...) },
	})
	if err != nil {
		log.Printf("split engine start: %v", err)
		if final {
			// Безопасный отказ: весь трафик остаётся в туннеле, пользователь видит причину.
			m.set(func(s *managerState) {
				s.splitSt = "failed"
				s.splitErr = "Раздельное туннелирование не запущено (весь трафик идёт через VPN): " + sanitizeErr(err)
			})
		}
		return
	}
	m.mu.Lock()
	m.engine = eng
	m.st.splitSt, m.st.splitErr = "running", ""
	m.mu.Unlock()
}

func (m *Manager) refreshEngine() {
	m.mu.Lock()
	eng := m.engine
	m.mu.Unlock()
	if eng == nil {
		return
	}
	state, msg, flows := eng.Status()
	m.mu.Lock()
	m.st.flows = flows
	if state == "failed" {
		m.st.splitSt = "failed"
		m.st.splitErr = "Раздельное туннелирование остановлено (весь трафик идёт через VPN): " + msg
		m.engine = nil
	}
	m.mu.Unlock()
}

// Disconnect останавливает туннель в фоне.
func (m *Manager) Disconnect() Response {
	m.mu.Lock()
	cur := m.st.state
	m.mu.Unlock()
	if cur == "stopped" {
		return Response{OK: true, Status: m.Status()}
	}
	if !m.opMu.TryLock() {
		// Идёт подключение/остановка: помечаем запрос и ждём освобождения в фоне.
		m.set(func(s *managerState) { s.state = "stopping" })
		go func() {
			m.opMu.Lock()
			defer m.opMu.Unlock()
			m.teardownLocked()
			m.set(func(s *managerState) { *s = managerState{state: "stopped", splitSt: "off"} })
		}()
		return Response{OK: true, Status: m.Status()}
	}
	m.set(func(s *managerState) { s.state = "stopping" })
	go func() {
		defer m.opMu.Unlock()
		m.teardownLocked()
		m.set(func(s *managerState) { *s = managerState{state: "stopped", splitSt: "off"} })
	}()
	return Response{OK: true, Status: m.Status()}
}

// Recover останавливает всё и удаляет остатки (службы туннеля, файлы конфигурации).
func (m *Manager) Recover() Response {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.teardownLocked()
	leftover := adapterExists()
	m.set(func(s *managerState) { *s = managerState{state: "stopped", splitSt: "off"} })
	if leftover {
		return errResp("adapter-left", "Сетевой адаптер туннеля ещё присутствует. Перезагрузите компьютер или удалите «PrivataVPN» в диспетчере устройств.")
	}
	return Response{OK: true, Status: m.Status()}
}

// teardownLocked: движок → служба туннеля → файл конфигурации → ожидание удаления адаптера.
// Вызывается под opMu. Идемпотентна.
func (m *Manager) teardownLocked() {
	m.mu.Lock()
	if m.stop != nil {
		close(m.stop)
		m.stop = nil
	}
	eng := m.engine
	m.engine = nil
	m.mu.Unlock()
	if eng != nil {
		eng.Stop()
		eng.Wait()
	}
	if err := removeTunnelService(); err != nil {
		log.Printf("removeTunnelService: %v", err)
	}
	_ = os.Remove(confPath())
	waitAdapterGone(10 * time.Second)
}

func adapterExists() bool {
	_, err := net.InterfaceByName(tunnelName)
	return err == nil
}

func waitAdapterGone(timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for adapterExists() && time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
	}
}

// SweepOrphans вызывается при старте службы: убирает туннель, оставшийся после сбоя.
func (m *Manager) SweepOrphans() {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.teardownLocked()
}

func (m *Manager) Logs(tail int) []string {
	if tail <= 0 || tail > 2000 {
		tail = 300
	}
	var buf bytes.Buffer
	if err := ringlogger.DumpTo(&buf, false); err != nil {
		return []string{"(журнал туннеля пока недоступен)"}
	}
	lines := strings.Split(strings.TrimRight(buf.String(), "\r\n"), "\n")
	if len(lines) > tail {
		lines = lines[len(lines)-tail:]
	}
	return lines
}

// ---- служба туннеля (SCM) ----

func tunnelServiceName() string {
	n, _ := services.ServiceNameOfTunnel(tunnelName)
	return n
}

func installTunnelService(path string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	name := tunnelServiceName()
	// Остатки предыдущей службы с тем же именем удаляются.
	if s, err := m.OpenService(name); err == nil {
		s.Control(svc.Stop)
		_ = s.Delete()
		s.Close()
		for i := 0; i < 40; i++ {
			s, err := m.OpenService(name)
			if err != nil && err != windows.ERROR_SERVICE_MARKED_FOR_DELETE {
				break
			}
			if s != nil {
				s.Close()
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	s, err := m.CreateService(name, exe, mgr.Config{
		ServiceType:  windows.SERVICE_WIN32_OWN_PROCESS,
		StartType:    mgr.StartManual, // не запускается сам при загрузке Windows
		ErrorControl: mgr.ErrorNormal,
		Dependencies: []string{"Nsi", "TcpIp"},
		DisplayName:  "Privata VPN: туннель",
		SidType:      windows.SERVICE_SID_TYPE_UNRESTRICTED,
	}, "/tunnelservice", path)
	if err != nil {
		return err
	}
	defer s.Close()
	return s.Start()
}

func queryTunnelService() (svc.State, uint32, error) {
	m, err := mgr.Connect()
	if err != nil {
		return 0, 0, err
	}
	defer m.Disconnect()
	s, err := m.OpenService(tunnelServiceName())
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return svc.Stopped, 0, nil
		}
		return 0, 0, err
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return 0, 0, err
	}
	code := st.Win32ExitCode
	if code == uint32(windows.ERROR_SERVICE_SPECIFIC_ERROR) {
		code = 0x10000 | st.ServiceSpecificExitCode // старший бит отмечает «код службы»
	}
	return st.State, code, nil
}

func removeTunnelService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(tunnelServiceName())
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return nil
		}
		return err
	}
	defer s.Close()
	if st, err := s.Query(); err == nil && st.State != svc.Stopped {
		if _, err := s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			log.Printf("stop tunnel service: %v", err)
		}
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			st, err := s.Query()
			if err != nil || st.State == svc.Stopped {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	if err := s.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
		return err
	}
	return nil
}

var serviceErrorTexts = map[uint32][2]string{
	uint32(services.ErrorRingloggerOpen):             {"ringlogger-open", "Не удалось открыть журнал туннеля."},
	uint32(services.ErrorLoadConfiguration):          {"load-config", "Служба не смогла загрузить конфигурацию."},
	uint32(services.ErrorCreateWintun):               {"create-wintun", "Не удалось создать сетевой адаптер Wintun (проверьте наличие wintun.dll)."},
	uint32(services.ErrorUAPIListen):                 {"uapi-listen", "Не удалось открыть канал управления туннелем."},
	uint32(services.ErrorDNSLookup):                  {"dns-lookup", "Не удалось определить адрес сервера по имени (DNS)."},
	uint32(services.ErrorFirewall):                   {"firewall", "Не удалось применить правила брандмауэра туннеля."},
	uint32(services.ErrorDeviceSetConfig):            {"device-config", "Не удалось применить параметры туннеля."},
	uint32(services.ErrorBindSocketsToDefaultRoutes): {"bind-sockets", "Не удалось привязать сокеты к маршруту по умолчанию."},
	uint32(services.ErrorSetNetConfig):               {"net-config", "Не удалось настроить адреса, маршруты или DNS адаптера."},
	uint32(services.ErrorDropPrivileges):             {"drop-privileges", "Не удалось понизить привилегии службы туннеля."},
	uint32(services.ErrorRunScript):                  {"run-script", "Ошибка выполнения скрипта конфигурации."},
	uint32(services.ErrorWin32):                      {"win32", "Внутренняя ошибка Windows."},
}

func describeExit(code uint32) (string, string) {
	if code&0x10000 != 0 {
		if t, ok := serviceErrorTexts[code&0xffff]; ok {
			return t[0], t[1]
		}
		return "tunnel-error", "Служба туннеля завершилась с ошибкой."
	}
	if code == 0 {
		return "tunnel-stopped", "Служба туннеля остановилась."
	}
	return "tunnel-win32", fmt.Sprintf("Служба туннеля завершилась с ошибкой Windows %d.", code)
}

// sanitizeErr оставляет только безопасный текст ошибки (без путей и ключей).
func sanitizeErr(err error) string {
	s := err.Error()
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

func resolveV4(host string) *[4]byte {
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			a := [4]byte(v4)
			return &a
		}
		return nil
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return nil
	}
	for _, ip := range ips {
		if v4 := ip.To4(); v4 != nil {
			a := [4]byte(v4)
			return &a
		}
	}
	return nil
}

// writeSecretFile записывает файл так, чтобы он был доступен только SYSTEM и администраторам.
func writeSecretFile(path string, data []byte) error {
	sd, err := windows.SecurityDescriptorFromString("O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)")
	if err != nil {
		return err
	}
	p16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := &windows.SecurityAttributes{Length: uint32(sizeofSA), SecurityDescriptor: sd}
	h, err := windows.CreateFile(p16, windows.GENERIC_WRITE, 0, sa, windows.CREATE_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(h), path)
	defer f.Close()
	_, err = f.Write(data)
	return err
}
