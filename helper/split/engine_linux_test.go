package split

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeRunner struct {
	mu    sync.Mutex
	calls []string
	stdin map[string]string
}

func (f *fakeRunner) Run(stdin, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	line := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, line)
	if stdin != "" {
		if f.stdin == nil {
			f.stdin = map[string]string{}
		}
		f.stdin[name] = stdin
	}
	switch {
	case name == "ip" && strings.Contains(line, "route get"):
		return []byte(`[{"dst":"203.0.113.7","gateway":"192.168.1.1","dev":"wlan0"}]`), nil
	case strings.Contains(line, "rule del"):
		if strings.Count(strings.Join(f.calls, "\n"), "rule del")%2 == 0 {
			return nil, fmt.Errorf("no such rule")
		}
	}
	return nil, nil
}

func (f *fakeRunner) has(sub string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if strings.Contains(c, sub) {
			return true
		}
	}
	return false
}

// fakeProc создаёт в каталоге подобие /proc для процесса.
func fakeProc(t *testing.T, root string, pid, ppid, start int, exe, cgroup string) {
	t.Helper()
	d := filepath.Join(root, strconv.Itoa(pid))
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(exe, filepath.Join(d, "exe")); err != nil {
		t.Fatal(err)
	}
	stat := fmt.Sprintf("%d (app (x)) S %d 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 %d 0 0", pid, ppid, start)
	os.WriteFile(filepath.Join(d, "stat"), []byte(stat), 0o644)
	os.WriteFile(filepath.Join(d, "cgroup"), []byte("0::"+cgroup+"\n"), 0o644)
}

type procWrite struct {
	path string
	pid  uint32
}

func recordWrites(t *testing.T) *[]procWrite {
	var mu sync.Mutex
	var got []procWrite
	old := writeProcs
	writeProcs = func(path string, pid uint32) error {
		mu.Lock()
		got = append(got, procWrite{path, pid})
		mu.Unlock()
		return nil
	}
	t.Cleanup(func() { writeProcs = old })
	return &got
}

func TestLinuxEngineMovesMatchingProcessesAndRestores(t *testing.T) {
	writes := recordWrites(t)
	proc := t.TempDir()
	cg := t.TempDir()
	os.MkdirAll(filepath.Join(cg, "user.slice"), 0o755)
	fakeProc(t, proc, 100, 1, 10, "/usr/lib/firefox/firefox", "/user.slice")
	fakeProc(t, proc, 101, 100, 20, "/usr/lib/firefox/plugin-container", "/user.slice") // потомок
	fakeProc(t, proc, 200, 1, 10, "/usr/bin/curl", "/user.slice")                       // посторонний
	fakeProc(t, proc, 300, 1, 10, "/usr/lib/firefox/firefox (deleted)", "/user.slice")  // обновлённый образ

	r := &fakeRunner{}
	ep := [4]byte{203, 0, 113, 7}
	e, err := Start(Params{Mode: ModeBypass, Apps: []string{"/usr/lib/firefox/firefox"}, TunName: "privata0", EndpointIP: &ep,
		CgroupRoot: cg, ProcRoot: proc, Runner: r, ScanEvery: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if !r.has("ip -4 route replace default via 192.168.1.1 dev wlan0 table 20562") || !r.has("ip -4 rule add fwmark 0x5052 lookup 20562 priority 90") {
		t.Fatalf("команды маршрутизации не выданы: %v", r.calls)
	}
	if !strings.Contains(r.stdin["nft"], `socket cgroupv2 level 2 "privata-vpn/apps" meta mark set 0x5052`) {
		t.Fatalf("правила nft не переданы:\n%s", r.stdin["nft"])
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, _, n := e.Status(); n == 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, _, n := e.Status(); n != 3 {
		t.Fatalf("перенесено процессов: %d, ожидалось 3 (firefox, потомок, firefox (deleted))", n)
	}
	for _, w := range *writes {
		if w.pid == 200 {
			t.Fatal("посторонний процесс перенесён")
		}
		if !strings.HasSuffix(w.path, filepath.Join(CgroupDir, CgroupSub, "cgroup.procs")) {
			t.Fatalf("перенос в неверную cgroup: %s", w.path)
		}
	}
	*writes = nil

	// «ядро» перенесло процессы: имитируем это, подменив их cgroup на нашу
	for _, pid := range []int{100, 101, 300} {
		os.WriteFile(filepath.Join(proc, strconv.Itoa(pid), "cgroup"), []byte("0::/privata-vpn/apps\n"), 0o644)
	}
	e.Stop()
	e.Wait()
	if !r.has("nft delete table ip privata_split") || !r.has("ip -4 route flush table 20562") {
		t.Fatalf("очистка не выполнена: %v", r.calls)
	}
	restored := map[uint32]string{}
	for _, w := range *writes {
		restored[w.pid] = w.path
	}
	for _, pid := range []uint32{100, 101, 300} {
		if restored[pid] != filepath.Join(cg, "user.slice", "cgroup.procs") {
			t.Errorf("процесс %d не возвращён в исходную cgroup: %q", pid, restored[pid])
		}
	}
	if _, err := os.Stat(filepath.Join(cg, CgroupDir)); !os.IsNotExist(err) {
		t.Error("каталог cgroup не удалён")
	}
}

func TestLinuxEngineStartValidation(t *testing.T) {
	r := &fakeRunner{}
	if _, err := Start(Params{Mode: ModeBypass, Apps: []string{"/bin/x"}, TunName: "privata0", Runner: r}); err == nil {
		t.Fatal("без адреса сервера движок не должен запускаться")
	}
	ep := [4]byte{1, 2, 3, 4}
	if _, err := Start(Params{Mode: ModeAll, TunName: "privata0", EndpointIP: &ep, Runner: r}); err == nil {
		t.Fatal("режим all не запускает движок")
	}
	if _, err := Start(Params{Mode: ModeBypass, Apps: []string{"cmd.exe /c x"}, TunName: "privata0", EndpointIP: &ep, Runner: r, CgroupRoot: t.TempDir(), ProcRoot: t.TempDir()}); err == nil {
		t.Fatal("недопустимый путь должен отклоняться")
	}
}
