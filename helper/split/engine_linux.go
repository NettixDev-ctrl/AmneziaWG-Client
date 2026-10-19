package split

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// writeProcs переносит процесс в cgroup (запись PID в cgroup.procs); в тестах подменяется.
var syscallESRCH error = syscallErrno(3)

var writeProcs = func(path string, pid uint32) error {
	return os.WriteFile(path, []byte(strconv.FormatUint(uint64(pid), 10)), 0o644)
}

// Runner запускает внешние команды (только с фиксированными аргументами). В тестах подменяется.
type Runner interface {
	Run(stdin string, name string, args ...string) ([]byte, error)
}

type execRunner struct{}

func (execRunner) Run(stdin, name string, args ...string) ([]byte, error) {
	cmd := exec.Command(name, args...)
	cmd.Env = []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.Bytes(), err
}

// Params — параметры запуска движка.
type Params struct {
	Mode       Mode
	Apps       []string
	TunName    string
	EndpointIP *[4]byte // адрес сервера (IPv4): по нему определяется физический маршрут
	FwMark     uint32   // fwmark пакетов самого туннеля (из awg show), 0 — неизвестен
	Logf       func(format string, args ...any)

	// Для тестов.
	CgroupRoot string
	CgroupDir  string // каталог внутри cgroupfs (по умолчанию «privata-vpn»)
	ProcRoot   string
	Runner     Runner
	ScanEvery  time.Duration
}

// Engine — раздельное туннелирование по приложениям на Linux.
//
// Приложения из списка (и их потомки) переносятся в cgroup v2 «privata-vpn/apps»; правила nftables по этой cgroup
// помечают их пакеты, а политика маршрутизации направляет помеченные пакеты через физический интерфейс.
type Engine struct {
	p      Params
	run    Runner
	procs  *linuxProcs
	match  *Matcher
	cgBase string

	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once

	mu     sync.Mutex
	state  string
	errMsg string
	route  RouteInfo
	moved  map[uint32]movedProc
}

type movedProc struct {
	start uint64
	orig  string // исходная cgroup (путь от корня cgroupfs)
}

func Start(p Params) (*Engine, error) {
	if p.Mode != ModeBypass && p.Mode != ModeInclude {
		return nil, errors.New("недопустимый режим раздельного туннелирования")
	}
	if p.EndpointIP == nil {
		return nil, errors.New("не удалось определить адрес сервера (нужен IPv4) для маршрута в обход туннеля")
	}
	if p.Logf == nil {
		p.Logf = func(string, ...any) {}
	}
	if p.CgroupRoot == "" {
		p.CgroupRoot = "/sys/fs/cgroup"
	}
	if p.CgroupDir == "" {
		p.CgroupDir = CgroupDir
	}
	if p.ProcRoot == "" {
		p.ProcRoot = "/proc"
	}
	if p.Runner == nil {
		p.Runner = execRunner{}
	}
	if p.ScanEvery == 0 {
		p.ScanEvery = 500 * time.Millisecond
	}
	procs := newLinuxProcs(p.ProcRoot)
	m, err := NewMatcher(p.Apps, procs, 2*time.Second)
	if err != nil {
		return nil, err
	}
	e := &Engine{p: p, run: p.Runner, procs: procs, match: m, stop: make(chan struct{}), done: make(chan struct{}), state: "starting", moved: map[uint32]movedProc{}}
	e.cgBase = filepath.Join(p.CgroupRoot, p.CgroupDir, CgroupSub)

	rules, err := LinuxRulesetFor(p.Mode, p.TunName, p.CgroupDir+"/"+CgroupSub)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(e.cgBase, 0o755); err != nil {
		return nil, fmt.Errorf("не удалось создать cgroup (нужен cgroup v2 и права root): %w", err)
	}
	if err := e.installRoute(); err != nil {
		e.cleanup()
		return nil, err
	}
	if out, err := e.run.Run(rules, "nft", "-f", "-"); err != nil {
		e.cleanup()
		return nil, fmt.Errorf("nftables отклонил правила (нужны модули nft_socket и nft_masq): %s", firstLine(out))
	}
	e.setState("running", "")
	go e.loop()
	return e, nil
}

func firstLine(b []byte) string {
	s := strings.TrimSpace(string(b))
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

// physRoute определяет маршрут к серверу в обход туннеля.
func (e *Engine) physRoute() (RouteInfo, error) {
	ep := e.p.EndpointIP
	args := []string{"-j", "-4", "route", "get", fmt.Sprintf("%d.%d.%d.%d", ep[0], ep[1], ep[2], ep[3])}
	if e.p.FwMark != 0 {
		args = append(args, "mark", strconv.FormatUint(uint64(e.p.FwMark), 10))
	}
	out, err := e.run.Run("", "ip", args...)
	if err != nil {
		return RouteInfo{}, fmt.Errorf("ip route get: %s", firstLine(out))
	}
	r, err := ParseRouteGet(out)
	if err != nil {
		return RouteInfo{}, err
	}
	if r.Dev == e.p.TunName {
		return RouteInfo{}, errors.New("маршрут к серверу ведёт в туннель")
	}
	return r, nil
}

func (e *Engine) installRoute() error {
	r, err := e.physRoute()
	if err != nil {
		return err
	}
	tbl := strconv.Itoa(LinuxTable)
	args := []string{"-4", "route", "replace", "default"}
	if r.Gateway != "" {
		args = append(args, "via", r.Gateway)
	}
	args = append(args, "dev", r.Dev, "table", tbl)
	if out, err := e.run.Run("", "ip", args...); err != nil {
		return fmt.Errorf("ip route: %s", firstLine(out))
	}
	e.removeRule()
	if out, err := e.run.Run("", "ip", "-4", "rule", "add", "fwmark", fmt.Sprintf("0x%x", LinuxMark), "lookup", tbl, "priority", strconv.Itoa(LinuxRulePriority)); err != nil {
		return fmt.Errorf("ip rule: %s", firstLine(out))
	}
	e.mu.Lock()
	e.route = r
	e.mu.Unlock()
	return nil
}

func (e *Engine) removeRule() {
	for i := 0; i < 8; i++ { // убираем возможные дубликаты
		if _, err := e.run.Run("", "ip", "-4", "rule", "del", "fwmark", fmt.Sprintf("0x%x", LinuxMark), "lookup", strconv.Itoa(LinuxTable), "priority", strconv.Itoa(LinuxRulePriority)); err != nil {
			return
		}
	}
}

func (e *Engine) loop() {
	defer close(e.done)
	scan := time.NewTicker(e.p.ScanEvery)
	route := time.NewTicker(3 * time.Second)
	defer scan.Stop()
	defer route.Stop()
	e.scanOnce()
	for {
		select {
		case <-e.stop:
			e.cleanup()
			return
		case <-scan.C:
			e.scanOnce()
		case <-route.C:
			e.mu.Lock()
			cur := e.route
			e.mu.Unlock()
			if r, err := e.physRoute(); err == nil && r != cur {
				e.p.Logf("раздельное туннелирование: изменился физический маршрут (%s → %s)", cur.Dev, r.Dev)
				if err := e.installRoute(); err != nil {
					e.p.Logf("не удалось обновить маршрут: %v", err)
				}
			}
		}
	}
}

// scanOnce переносит в cgroup процессы, подходящие под правила (включая потомков).
func (e *Engine) scanOnce() {
	now := time.Now()
	self := uint32(os.Getpid())
	alive := map[uint32]bool{}
	for _, pid := range e.procs.listPIDs() {
		alive[pid] = true
		if pid == self || pid == 1 {
			continue
		}
		info, ok := e.procs.Info(pid)
		if !ok {
			continue
		}
		e.mu.Lock()
		mv, done := e.moved[pid]
		e.mu.Unlock()
		if done && mv.start == info.CreateTime {
			continue
		}
		if !e.match.Matches(pid, now) {
			continue
		}
		e.movePID(pid, info.CreateTime)
	}
	e.mu.Lock()
	for pid := range e.moved {
		if !alive[pid] {
			delete(e.moved, pid)
		}
	}
	e.mu.Unlock()
}

func (e *Engine) movePID(pid uint32, start uint64) {
	cur, _ := os.ReadFile(filepath.Join(e.p.ProcRoot, strconv.FormatUint(uint64(pid), 10), "cgroup"))
	orig, _ := ParseCgroupV2(string(cur))
	if err := writeProcs(filepath.Join(e.cgBase, "cgroup.procs"), pid); err != nil {
		if !os.IsNotExist(err) && !errors.Is(err, syscallESRCH) {
			e.p.Logf("раздельное туннелирование: не удалось перенести процесс %d в cgroup: %v", pid, err)
		}
		return // процесс мог завершиться
	}
	e.p.Logf("раздельное туннелирование: процесс %d перенесён в cgroup", pid)
	e.mu.Lock()
	e.moved[pid] = movedProc{start: start, orig: orig}
	e.mu.Unlock()
}

// cleanup удаляет правила и возвращает процессы в исходные cgroup.
func (e *Engine) cleanup() {
	e.run.Run("", "nft", "delete", "table", "ip", SplitNftTable)
	e.removeRule()
	e.run.Run("", "ip", "-4", "route", "flush", "table", strconv.Itoa(LinuxTable))
	e.mu.Lock()
	moved := e.moved
	e.moved = map[uint32]movedProc{}
	e.mu.Unlock()
	for pid, mv := range moved {
		cur, err := os.ReadFile(filepath.Join(e.p.ProcRoot, strconv.FormatUint(uint64(pid), 10), "cgroup"))
		if err != nil {
			continue
		}
		if p, ok := ParseCgroupV2(string(cur)); !ok || p != "/"+filepath.ToSlash(filepath.Join(e.p.CgroupDir, CgroupSub)) {
			continue // процесс уже в другой cgroup
		}
		dst := filepath.Join(e.p.CgroupRoot, filepath.FromSlash(mv.orig), "cgroup.procs")
		if mv.orig == "" || writeProcs(dst, pid) != nil {
			_ = writeProcs(filepath.Join(e.p.CgroupRoot, "cgroup.procs"), pid)
		}
	}
	_ = os.Remove(e.cgBase)
	_ = os.Remove(filepath.Join(e.p.CgroupRoot, e.p.CgroupDir))
}

func (e *Engine) setState(s, msg string) {
	e.mu.Lock()
	e.state, e.errMsg = s, msg
	e.mu.Unlock()
}

// Stop останавливает движок; повторные вызовы безопасны.
func (e *Engine) Stop() { e.stopOnce.Do(func() { close(e.stop) }) }

// Wait блокируется до полной остановки и очистки.
func (e *Engine) Wait() { <-e.done }

// Status возвращает состояние, сообщение об ошибке и число перенесённых процессов.
func (e *Engine) Status() (state, errMsg string, flows int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.state, e.errMsg, len(e.moved)
}

// CleanupLeftovers удаляет следы движка после аварийного завершения (используется командой recover).
func CleanupLeftovers(r Runner, cgroupRoot string) {
	if r == nil {
		r = execRunner{}
	}
	if cgroupRoot == "" {
		cgroupRoot = "/sys/fs/cgroup"
	}
	r.Run("", "nft", "delete", "table", "ip", SplitNftTable)
	for i := 0; i < 8; i++ {
		if _, err := r.Run("", "ip", "-4", "rule", "del", "fwmark", fmt.Sprintf("0x%x", LinuxMark), "lookup", strconv.Itoa(LinuxTable), "priority", strconv.Itoa(LinuxRulePriority)); err != nil {
			break
		}
	}
	r.Run("", "ip", "-4", "route", "flush", "table", strconv.Itoa(LinuxTable))
	base := filepath.Join(cgroupRoot, CgroupDir, CgroupSub)
	if data, err := os.ReadFile(filepath.Join(base, "cgroup.procs")); err == nil {
		for _, f := range strings.Fields(string(data)) {
			if n, err := strconv.ParseUint(f, 10, 32); err == nil {
				_ = writeProcs(filepath.Join(cgroupRoot, "cgroup.procs"), uint32(n))
			}
		}
	}
	_ = os.Remove(base)
	_ = os.Remove(filepath.Join(cgroupRoot, CgroupDir))
}
