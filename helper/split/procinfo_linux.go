package split

import (
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// linuxProcs читает сведения о процессах из /proc (корень можно подменить в тестах).
type linuxProcs struct {
	root  string
	mu    sync.Mutex
	cache map[uint32]procEntry
}

type procEntry struct {
	info    ProcInfo
	expires time.Time
}

func newLinuxProcs(root string) *linuxProcs {
	return &linuxProcs{root: root, cache: make(map[uint32]procEntry)}
}

func (p *linuxProcs) Info(pid uint32) (ProcInfo, bool) {
	now := time.Now()
	p.mu.Lock()
	if e, ok := p.cache[pid]; ok && now.Before(e.expires) {
		p.mu.Unlock()
		return e.info, true
	}
	p.mu.Unlock()

	dir := filepath.Join(p.root, strconv.FormatUint(uint64(pid), 10))
	exe, err := os.Readlink(filepath.Join(dir, "exe"))
	if err != nil {
		return ProcInfo{}, false // поток ядра или нет доступа
	}
	stat, err := os.ReadFile(filepath.Join(dir, "stat"))
	if err != nil {
		return ProcInfo{}, false
	}
	ppid, start, err := ParseProcStat(string(stat))
	if err != nil {
		return ProcInfo{}, false
	}
	info := ProcInfo{Path: exe, ParentPID: ppid, CreateTime: start}
	p.mu.Lock()
	if len(p.cache) > 4096 {
		for k, v := range p.cache {
			if now.After(v.expires) {
				delete(p.cache, k)
			}
		}
	}
	p.cache[pid] = procEntry{info: info, expires: now.Add(2 * time.Second)}
	p.mu.Unlock()
	return info, true
}

func (p *linuxProcs) listPIDs() []uint32 {
	entries, err := os.ReadDir(p.root)
	if err != nil {
		return nil
	}
	var out []uint32
	for _, e := range entries {
		if n, err := strconv.ParseUint(e.Name(), 10, 32); err == nil {
			out = append(out, uint32(n))
		}
	}
	return out
}
