package split

import (
	"errors"
	"strings"
	"sync"
	"time"
)

// Mode — режим раздельного туннелирования.
type Mode string

const (
	ModeAll     Mode = "all"     // весь трафик через VPN (движок не запускается)
	ModeInclude Mode = "include" // через VPN идут только выбранные приложения
	ModeBypass  Mode = "bypass"  // выбранные приложения идут мимо VPN
)

func (m Mode) Valid() bool { return m == ModeAll || m == ModeInclude || m == ModeBypass }

// NormalizePath приводит путь к виду для сравнения: нижний регистр, обратные слеши.
// Возвращает ошибку для путей, которые не могут идентифицировать приложение.
func NormalizePath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" || len(p) > 1024 {
		return "", errors.New("пустой или слишком длинный путь")
	}
	if strings.HasPrefix(p, "/") {
		return normalizePosix(p)
	}
	p = strings.ReplaceAll(p, "/", `\`)
	if strings.HasPrefix(p, `\\?\`) {
		p = p[4:]
		if strings.HasPrefix(strings.ToUpper(p), `UNC\`) {
			p = `\\` + p[4:]
		}
	}
	isDrive := len(p) >= 3 && p[1] == ':' && p[2] == '\\' && ((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z'))
	isUNC := strings.HasPrefix(p, `\\`) && !strings.HasPrefix(p, `\\.`)
	if !isDrive && !isUNC {
		return "", errors.New("путь должен быть абсолютным")
	}
	for _, seg := range strings.Split(strings.TrimPrefix(p, `\\`), `\`) {
		if seg == ".." || seg == "." {
			return "", errors.New("недопустимые сегменты пути")
		}
	}
	if strings.ContainsAny(p, "*?\"<>|\x00") || !strings.HasSuffix(strings.ToLower(p), ".exe") {
		return "", errors.New("путь должен указывать на .exe без подстановочных знаков")
	}
	return strings.ToLower(p), nil
}

// normalizePosix проверяет абсолютный путь POSIX; регистр сохраняется.
func normalizePosix(p string) (string, error) {
	if strings.ContainsAny(p, "*?\"<>|\x00") {
		return "", errors.New("недопустимые символы в пути")
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("недопустимые символы в пути")
		}
	}
	var out []string
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "":
		case ".", "..":
			return "", errors.New("недопустимые сегменты пути")
		default:
			out = append(out, seg)
		}
	}
	if len(out) == 0 {
		return "", errors.New("путь не указывает на файл")
	}
	return "/" + strings.Join(out, "/"), nil
}

// PathKey — ключ сравнения: пути Windows нечувствительны к регистру, пути POSIX — нет.
// Суффикс « (deleted)», который Linux добавляет к удалённому образу, отбрасывается.
func PathKey(p string) string {
	p = strings.TrimSuffix(p, " (deleted)")
	if strings.HasPrefix(p, "/") {
		return p
	}
	return strings.ToLower(strings.ReplaceAll(p, "/", `\`))
}

// ProcInfo — сведения о процессе, нужные для сопоставления.
type ProcInfo struct {
	Path       string // полный путь образа (как вернула система)
	ParentPID  uint32
	CreateTime uint64 // FILETIME; 0 — неизвестно
}

// ProcInfoProvider получает сведения о процессе. Реализация для Windows — в process_windows.go.
type ProcInfoProvider interface {
	Info(pid uint32) (ProcInfo, bool)
}

type matchCacheEntry struct {
	create  uint64
	matched bool
	expires time.Time
}

// Matcher определяет, относится ли процесс (или один из его предков) к списку приложений.
// Приложение идентифицируется ПОЛНЫМ путём, а не именем; дочерние процессы наследуют правило —
// так поддерживаются приложения из нескольких процессов (браузеры, Electron и т.п.).
type Matcher struct {
	apps  map[string]struct{}
	prov  ProcInfoProvider
	ttl   time.Duration
	mu    sync.Mutex
	cache map[uint32]matchCacheEntry
}

const maxAncestorDepth = 16

func NewMatcher(paths []string, prov ProcInfoProvider, ttl time.Duration) (*Matcher, error) {
	m := &Matcher{apps: make(map[string]struct{}, len(paths)), prov: prov, ttl: ttl, cache: make(map[uint32]matchCacheEntry)}
	for _, p := range paths {
		n, err := NormalizePath(p)
		if err != nil {
			return nil, err
		}
		m.apps[PathKey(n)] = struct{}{}
	}
	return m, nil
}

func (m *Matcher) Matches(pid uint32, now time.Time) bool {
	if pid == 0 {
		return false
	}
	info, ok := m.prov.Info(pid)
	if !ok {
		return false
	}
	m.mu.Lock()
	if c, ok := m.cache[pid]; ok && c.create == info.CreateTime && now.Before(c.expires) {
		m.mu.Unlock()
		return c.matched
	}
	m.mu.Unlock()

	matched := m.walk(pid, info)
	m.mu.Lock()
	if len(m.cache) > 4096 {
		for k, v := range m.cache {
			if now.After(v.expires) {
				delete(m.cache, k)
			}
		}
	}
	m.cache[pid] = matchCacheEntry{create: info.CreateTime, matched: matched, expires: now.Add(m.ttl)}
	m.mu.Unlock()
	return matched
}

func (m *Matcher) walk(pid uint32, info ProcInfo) bool {
	cur := info
	curPID := pid
	for depth := 0; depth < maxAncestorDepth; depth++ {
		if _, ok := m.apps[PathKey(cur.Path)]; ok {
			return true
		}
		parent := cur.ParentPID
		if parent == 0 || parent == 4 || parent == curPID {
			return false
		}
		pi, ok := m.prov.Info(parent)
		if !ok {
			return false
		}
		// Защита от повторного использования PID: родитель обязан быть создан раньше потомка.
		if cur.CreateTime != 0 && pi.CreateTime != 0 && pi.CreateTime >= cur.CreateTime {
			return false
		}
		cur, curPID = pi, parent
	}
	return false
}
