//go:build linux

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/privata/awg-client/helper/split"
)

const (
	version    = "0.1.0"
	runDirPath = "/run/privata-vpn"
	sockPath   = "/run/privata-vpn/helper.sock"
	confName   = tunnelIface + ".conf"
	cmdPath    = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)

// awgGoImpl — реализация userspace (имя или абсолютный путь); меняется флагом --awg-go при запуске службы.
var awgGoImpl = "amneziawg-go"

func confPath() string { return filepath.Join(runDirPath, confName) }

// Manager управляет единственным туннелем AmneziaWG на Linux: запускает штатный `awg-quick`
// (интерфейс, маршруты, DNS, fwmark-маршрутизация), добавляет kill switch (nftables) и раздельное
// туннелирование и следит за рукопожатием через `awg show`.
type Manager struct {
	mu   sync.Mutex
	st   managerState
	opMu sync.Mutex
	stop chan struct{}

	engine *split.Engine
	logs   logRing
}

type managerState struct {
	state     string
	errCode   string
	errMsg    string
	rx, tx    uint64
	hsAge     *float64
	splitMode split.Mode
	splitApps []string
	endpoint  *[4]byte
	fwmark    uint32
	splitSt   string
	splitErr  string
	flows     int
	options   Options
}

func NewManager() *Manager {
	return &Manager{st: managerState{state: "stopped", splitSt: "off"}}
}

type logRing struct {
	mu    sync.Mutex
	lines []string
}

func (l *logRing) add(s string) {
	l.mu.Lock()
	l.lines = append(l.lines, time.Now().Format(time.RFC3339)+" "+s)
	if len(l.lines) > 300 {
		l.lines = l.lines[len(l.lines)-300:]
	}
	l.mu.Unlock()
}

func (m *Manager) logf(format string, a ...any) {
	s := fmt.Sprintf(format, a...)
	m.logs.add(s)
	fmt.Fprintln(os.Stderr, "[helper]", s)
}

func (m *Manager) set(f func(s *managerState)) {
	m.mu.Lock()
	f(&m.st)
	m.mu.Unlock()
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

func (m *Manager) Logs(tail int) []string {
	m.logs.mu.Lock()
	defer m.logs.mu.Unlock()
	if tail <= 0 || tail > len(m.logs.lines) {
		tail = len(m.logs.lines)
	}
	return append([]string(nil), m.logs.lines[len(m.logs.lines)-tail:]...)
}

// ---- внешние команды (только фиксированные аргументы, чистое окружение) ----

func runCmd(ctx context.Context, stdin string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = []string{"PATH=" + cmdPath, "LC_ALL=C", "WG_QUICK_USERSPACE_IMPLEMENTATION=" + awgGoImpl}
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.Bytes(), err
}

func runShort(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return runCmd(ctx, "", name, args...)
}

func lookTool(name string) bool {
	for _, d := range strings.Split(cmdPath, ":") {
		if st, err := os.Stat(filepath.Join(d, name)); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return true
		}
	}
	return false
}

// missingTools возвращает отсутствующие компоненты, необходимые для запроса.
func missingTools(needNft bool) []string {
	var miss []string
	for _, t := range []string{"awg-quick", "awg", "ip"} {
		if !lookTool(t) {
			miss = append(miss, t)
		}
	}
	if !lookTool("amneziawg-go") {
		if _, err := os.Stat("/sys/module/amneziawg"); err != nil {
			miss = append(miss, "amneziawg-go (или модуль ядра amneziawg)")
		}
	}
	if needNft && !lookTool("nft") {
		miss = append(miss, "nft")
	}
	return miss
}

func tunnelUp() bool {
	_, err := net.InterfaceByName(tunnelIface)
	return err == nil
}

// ---- подключение ----

func (m *Manager) Connect(v *ValidatedConnect) Response {
	pc, err := SanitizeConf(v.Config)
	if err != nil {
		return errResp("bad-config", "Конфигурация отклонена: "+err.Error())
	}
	if miss := missingTools(v.Options.KillSwitch || v.SplitMode != split.ModeAll); len(miss) > 0 {
		return errResp("tools-missing", "Не найдены компоненты: "+strings.Join(miss, ", ")+". Установите amneziawg-tools и amneziawg-go.")
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
	var ep *[4]byte
	var epAddr netip.Addr
	ips, _ := net.LookupIP(pc.EndpointHost)
	for _, ip := range ips {
		if v4 := ip.To4(); v4 != nil && ep == nil {
			a := [4]byte(v4)
			ep = &a
		}
	}
	if len(ips) > 0 {
		epAddr, _ = netip.AddrFromSlice(ips[0])
		epAddr = epAddr.Unmap()
	}
	m.set(func(s *managerState) {
		*s = managerState{state: "starting", splitMode: v.SplitMode, splitApps: v.SplitApps, endpoint: ep, splitSt: "off", options: v.Options}
	})
	go func() {
		defer m.opMu.Unlock()
		m.runConnect(pc, epAddr)
	}()
	return Response{OK: true, Status: m.Status()}
}

func (m *Manager) runConnect(pc *ParsedConf, epAddr netip.Addr) {
	fail := func(code, msg string) {
		m.logf("подключение не удалось: %s", code)
		m.teardownLocked()
		m.set(func(s *managerState) { s.state, s.errCode, s.errMsg = "failed", code, msg })
	}
	m.teardownLocked() // остатки прошлого запуска
	m.set(func(s *managerState) { s.state, s.errCode, s.errMsg = "starting", "", "" })

	if err := os.MkdirAll(runDirPath, 0o755); err != nil {
		fail("run-dir", "Не удалось подготовить каталог службы.")
		return
	}
	_ = os.Remove(confPath())
	if err := os.WriteFile(confPath(), []byte(pc.Text), 0o600); err != nil {
		fail("write-config", "Не удалось сохранить конфигурацию для туннеля.")
		return
	}
	m.mu.Lock()
	opts, mode := m.st.options, m.st.splitMode
	m.mu.Unlock()

	if opts.KillSwitch {
		rules := KillSwitchRuleset(KSParams{Endpoint: epAddr, Port: pc.EndpointPort, AllowLAN: opts.AllowLAN, AllowSplitMark: mode != split.ModeAll})
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		out, err := runCmd(ctx, "add table inet "+ksTable+"\ndelete table inet "+ksTable+"\n"+rules, "nft", "-f", "-")
		cancel()
		if err != nil {
			m.logf("nft kill switch: %s", firstLine(out))
			fail("killswitch", "Не удалось включить kill switch (nftables): "+firstLine(out))
			return
		}
	}

	m.pinEndpoint(epAddr)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	out, err := runCmd(ctx, "", "awg-quick", "up", confPath())
	cancel()
	if err != nil {
		m.logf("awg-quick up: %s", firstLine(out))
		fail("awg-quick-failed", "awg-quick не смог поднять туннель: "+lastLines(out, 3))
		return
	}
	m.logf("awg-quick up выполнен")

	if out, err := runCmd(context.Background(), TuneRuleset(true), "nft", "-f", "-"); err != nil {
		m.logf("nft tune (MSS/IPv6): %s", firstLine(out))
	}
	if len(pc.DNS) > 0 {
		args := append([]string{"dns", tunnelIface}, pc.DNS...)
		if out, err := runShort("resolvectl", args...); err != nil {
			m.logf("resolvectl dns: %s", firstLine(out))
		} else {
			_, _ = runShort("resolvectl", "domain", tunnelIface, "~.")
		}
	}

	stop := make(chan struct{})
	m.mu.Lock()
	m.stop = stop
	m.mu.Unlock()
	go m.monitor(stop)
}

// testCgroupDir — тестовый хук: PRIVATA_CGROUP_DIR задаёт каталог cgroup (только из окружения root; pkexec окружение очищает).
func testCgroupDir() string {
	d := strings.Trim(os.Getenv("PRIVATA_CGROUP_DIR"), "/")
	if d == "" || strings.Contains(d, "..") || strings.ContainsAny(d, " \t\n\"\\;{}") {
		return ""
	}
	return d
}

var pinnedEndpoint string

// pinEndpoint закрепляет маршрут до сервера через реальный шлюз, чтобы другой VPN/прокси-интерфейс
// с маршрутом по умолчанию (например, TUN другого клиента) не перехватывал пакеты рукопожатия.
func (m *Manager) pinEndpoint(ep netip.Addr) {
	if !ep.IsValid() || !ep.Is4() {
		return
	}
	out, err := runShort("ip", "-j", "-4", "route", "show", "default")
	if err != nil {
		return
	}
	var rows []struct {
		Dev     string `json:"dev"`
		Gateway string `json:"gateway"`
		Metric  int    `json:"metric"`
	}
	if json.Unmarshal(out, &rows) != nil {
		return
	}
	best := -1
	for i, r := range rows {
		if r.Gateway == "" || r.Dev == "" || strings.ContainsAny(r.Dev+r.Gateway, " ;") {
			continue
		}
		if best < 0 || r.Metric < rows[best].Metric {
			best = i
		}
	}
	if best < 0 {
		return
	}
	r := rows[best]
	if _, err := runShort("ip", "-4", "route", "replace", ep.String()+"/32", "via", r.Gateway, "dev", r.Dev); err == nil {
		pinnedEndpoint = ep.String() + "/32"
		m.logf("маршрут до сервера закреплён через %s (%s)", r.Dev, r.Gateway)
	}
}

func firstLine(b []byte) string {
	s := strings.TrimSpace(string(b))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return clip(s)
}

func lastLines(b []byte, n int) string {
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	var keep []string
	for _, l := range lines {
		l = strings.TrimSpace(l)
		// строки «[#] команда» — эхо выполняемых команд, в них нет полезного сообщения об ошибке
		if l != "" && !strings.HasPrefix(l, "[#]") {
			keep = append(keep, l)
		}
	}
	if len(keep) > n {
		keep = keep[len(keep)-n:]
	}
	return clip(strings.Join(keep, " | "))
}

func clip(s string) string {
	if len(s) > 240 {
		return s[:240]
	}
	return s
}

func (m *Manager) monitor(stop chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	tries := 0
	ticks := 0
	var lastRx uint64
	var stallSince time.Time
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		if !tunnelUp() {
			m.logf("интерфейс туннеля исчез")
			go func() {
				m.opMu.Lock()
				defer m.opMu.Unlock()
				m.mu.Lock()
				still := m.stop == stop
				m.mu.Unlock()
				if !still {
					return
				}
				m.teardown(true)
				m.set(func(s *managerState) {
					s.state, s.errCode, s.errMsg = "failed", "tunnel-terminated", "Туннель неожиданно завершил работу (процесс amneziawg-go остановился)."
				})
			}()
			return
		}
		out, err := runShort("awg", "show", tunnelIface, "dump")
		m.mu.Lock()
		if err == nil {
			if d, perr := ParseAwgDump(string(out)); perr == nil {
				m.st.rx, m.st.tx, m.st.fwmark = d.Rx, d.Tx, d.FwMark
				if d.LastHandshake.IsZero() {
					m.st.hsAge = nil
				} else {
					a := time.Since(d.LastHandshake).Seconds()
					if a < 0 {
						a = 0
					}
					m.st.hsAge = &a
				}
			}
		}
		if m.st.state == "starting" {
			m.st.state = "running"
		}
		ticks++
		// Журнал состояния раз в 30 с: помогает разобрать «тихие» обрывы (возраст рукопожатия, счётчики трафика).
		if ticks%30 == 0 {
			hs := "нет"
			if m.st.hsAge != nil {
				hs = fmt.Sprintf("%.0f с", *m.st.hsAge)
			}
			go m.logf("состояние: рукопожатие %s назад, принято %d Б, отправлено %d Б", hs, m.st.rx, m.st.tx)
		}
		// Тихий обрыв: отправляем, но ничего не принимаем дольше 45 с — подсказка приложению переподключиться.
		if m.st.rx != lastRx || m.st.tx == 0 {
			lastRx, stallSince = m.st.rx, time.Time{}
		} else if stallSince.IsZero() {
			stallSince = time.Now()
		} else if time.Since(stallSince) > 45*time.Second && m.st.hsAge != nil && *m.st.hsAge > 150 {
			a := *m.st.hsAge + 1000 // превышает любой порог устаревания → приложение покажет «нет ответа» и переподключится
			m.st.hsAge = &a
		}
		need := m.st.splitMode != split.ModeAll && m.engine == nil && m.st.splitSt != "failed"
		mode, apps, ep, fwmark := m.st.splitMode, m.st.splitApps, m.st.endpoint, m.st.fwmark
		m.mu.Unlock()
		if need {
			tries++
			m.startEngine(mode, apps, ep, fwmark, tries >= 10)
		}
		m.refreshEngine()
	}
}

func (m *Manager) startEngine(mode split.Mode, apps []string, ep *[4]byte, fwmark uint32, final bool) {
	m.set(func(s *managerState) { s.splitSt = "starting" })
	eng, err := split.Start(split.Params{Mode: mode, Apps: apps, TunName: tunnelIface, EndpointIP: ep, FwMark: fwmark, Logf: m.logf, CgroupDir: testCgroupDir()})
	if err != nil {
		m.logf("split engine: %v", err)
		if final {
			m.set(func(s *managerState) {
				s.splitSt = "failed"
				s.splitErr = "Раздельное туннелирование не запущено (весь трафик идёт через VPN): " + clip(err.Error())
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
		m.st.splitSt, m.st.splitErr = "failed", "Раздельное туннелирование остановлено (весь трафик идёт через VPN): "+msg
		m.engine = nil
	}
	m.mu.Unlock()
}

func (m *Manager) Disconnect() Response {
	m.mu.Lock()
	cur := m.st.state
	m.mu.Unlock()
	if cur == "stopped" {
		return Response{OK: true, Status: m.Status()}
	}
	m.set(func(s *managerState) { s.state = "stopping" })
	go func() {
		m.opMu.Lock()
		defer m.opMu.Unlock()
		m.teardownLocked()
		m.set(func(s *managerState) { *s = managerState{state: "stopped", splitSt: "off"} })
	}()
	return Response{OK: true, Status: m.Status()}
}

func (m *Manager) Recover() Response {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.teardownLocked()
	m.set(func(s *managerState) { *s = managerState{state: "stopped", splitSt: "off"} })
	if tunnelUp() {
		return errResp("adapter-left", "Интерфейс privata0 не удалось удалить. Выполните: sudo ip link del privata0")
	}
	return Response{OK: true, Status: m.Status()}
}

// teardownLocked: раздельное туннелирование → awg-quick down → kill switch → файл конфигурации.
// Вызывается под opMu. Идемпотентна: безопасно вызывать при любом состоянии.
func (m *Manager) teardownLocked() { m.teardown(false) }

// teardown выполняет очистку; keepKillSwitch=true сохраняет правила kill switch (аварийное завершение
// туннеля: сеть остаётся заблокированной, пока пользователь не отключится или не переподключится).
func (m *Manager) teardown(keepKillSwitch bool) {
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
	split.CleanupLeftovers(nil, "")
	cleanupTunnel(m.logf)
	_, _ = runShort("nft", "delete", "table", "inet", tuneTable)
	if pinnedEndpoint != "" {
		_, _ = runShort("ip", "-4", "route", "del", pinnedEndpoint)
		pinnedEndpoint = ""
	}
	if !keepKillSwitch {
		_, _ = runShort("nft", "delete", "table", "inet", ksTable)
	}
	_ = os.Remove(confPath())
}

// cleanupTunnel поднимает/удаляет интерфейс штатными средствами, а при отсутствии конфигурации чистит вручную.
func cleanupTunnel(logf func(string, ...any)) {
	if _, err := os.Stat(confPath()); err == nil && tunnelUp() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		out, err := runCmd(ctx, "", "awg-quick", "down", confPath())
		cancel()
		if err != nil {
			logf("awg-quick down: %s", firstLine(out))
		}
	}
	if tunnelUp() {
		_, _ = runShort("ip", "link", "del", tunnelIface)
	}
	// Остатки политики маршрутизации awg-quick (если интерфейс исчез аварийно).
	for _, fam := range []string{"-4", "-6"} {
		for i := 0; i < 4; i++ {
			if _, err := runShort("ip", fam, "rule", "del", "not", "fwmark", "51820", "table", "51820"); err != nil {
				break
			}
		}
		for i := 0; i < 4; i++ {
			if _, err := runShort("ip", fam, "rule", "del", "table", "main", "suppress_prefixlength", "0"); err != nil {
				break
			}
		}
		_, _ = runShort("ip", fam, "route", "flush", "table", "51820")
	}
	_, _ = runShort("resolvectl", "revert", tunnelIface)
}

func (m *Manager) SweepOrphans() {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.teardownLocked()
}

var errNotRoot = errors.New("нужны права root")
