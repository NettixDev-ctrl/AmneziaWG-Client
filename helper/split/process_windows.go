package split

import (
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// procProvider получает путь образа, родителя и время создания процесса.
type procProvider struct {
	mu    sync.Mutex
	cache map[uint32]procCacheEntry
}

type procCacheEntry struct {
	info    ProcInfo
	expires time.Time
}

func newProcProvider() *procProvider { return &procProvider{cache: make(map[uint32]procCacheEntry)} }

func (p *procProvider) Info(pid uint32) (ProcInfo, bool) {
	now := time.Now()
	p.mu.Lock()
	if e, ok := p.cache[pid]; ok && now.Before(e.expires) {
		p.mu.Unlock()
		return e.info, true
	}
	p.mu.Unlock()

	info, ok := queryProcess(pid)
	if !ok {
		return ProcInfo{}, false
	}
	p.mu.Lock()
	if len(p.cache) > 4096 {
		for k, v := range p.cache {
			if now.After(v.expires) {
				delete(p.cache, k)
			}
		}
	}
	p.cache[pid] = procCacheEntry{info: info, expires: now.Add(5 * time.Second)}
	p.mu.Unlock()
	return info, true
}

func queryProcess(pid uint32) (ProcInfo, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ProcInfo{}, false
	}
	defer windows.CloseHandle(h)

	var info ProcInfo
	buf := make([]uint16, 32768)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size); err != nil {
		return ProcInfo{}, false
	}
	info.Path = windows.UTF16ToString(buf[:size])

	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &creation, &exit, &kernel, &user); err == nil {
		info.CreateTime = uint64(creation.HighDateTime)<<32 | uint64(creation.LowDateTime)
	}

	var pbi windows.PROCESS_BASIC_INFORMATION
	var retLen uint32
	if err := windows.NtQueryInformationProcess(h, windows.ProcessBasicInformation, unsafe.Pointer(&pbi), uint32(unsafe.Sizeof(pbi)), &retLen); err == nil {
		info.ParentPID = uint32(pbi.InheritedFromUniqueProcessId)
	}
	return info, true
}
