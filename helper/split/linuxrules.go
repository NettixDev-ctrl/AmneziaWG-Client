package split

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Параметры раздельного туннелирования на Linux (cgroup v2 + nftables + политика маршрутизации).
const (
	LinuxMark         = 0x5052 // fwmark пакетов, идущих мимо VPN
	LinuxTable        = 0x5052 // номер таблицы маршрутизации с маршрутом по умолчанию через физический интерфейс
	LinuxRulePriority = 90     // раньше правил awg-quick
	CgroupDir         = "privata-vpn"
	CgroupSub         = "apps"
	SplitNftTable     = "privata_split"
)

// LinuxRuleset возвращает набор правил nftables.
//
// Выбранные приложения помещаются службой в cgroup «privata-vpn/apps». Пакеты, которые иначе пошли бы в туннель:
//   - bypass:  пакеты процессов из cgroup получают метку и уходят через физический интерфейс;
//   - include: метку получают пакеты всех процессов, КРОМЕ процессов из cgroup.
//
// Метка заставляет ядро повторно выбрать маршрут (chain type route) по таблице LinuxTable, а masquerade меняет
// адрес источника с адреса туннеля на адрес физического интерфейса; ответы возвращает conntrack.
func LinuxRuleset(mode Mode, tun string) (string, error) {
	return LinuxRulesetFor(mode, tun, CgroupDir+"/"+CgroupSub)
}

// LinuxRulesetFor — то же для произвольного пути cgroup (относительно корня cgroupfs).
func LinuxRulesetFor(mode Mode, tun, cgroupRel string) (string, error) {
	if mode != ModeBypass && mode != ModeInclude {
		return "", errors.New("режим не требует правил")
	}
	if tun == "" || strings.ContainsAny(tun, " \t\"\\;{}") || len(tun) > 15 {
		return "", errors.New("недопустимое имя интерфейса")
	}
	segs := strings.Split(strings.Trim(cgroupRel, "/"), "/")
	for _, sg := range segs {
		if sg == "" || sg == "." || sg == ".." || strings.ContainsAny(sg, "\"\\;{} \t\n") {
			return "", errors.New("недопустимый путь cgroup")
		}
	}
	cg := fmt.Sprintf(`"%s"`, strings.Join(segs, "/"))
	level := len(segs)
	var b strings.Builder
	fmt.Fprintf(&b, "add table ip %s\ndelete table ip %s\n", SplitNftTable, SplitNftTable)
	fmt.Fprintf(&b, "table ip %s {\n  chain mark_out {\n    type route hook output priority mangle; policy accept;\n", SplitNftTable)
	b.WriteString("    meta mark != 0 return\n")
	fmt.Fprintf(&b, "    oifname != \"%s\" return\n", tun)
	if mode == ModeBypass {
		fmt.Fprintf(&b, "    socket cgroupv2 level %d %s meta mark set 0x%x\n", level, cg, LinuxMark)
	} else {
		fmt.Fprintf(&b, "    socket cgroupv2 level %d %s return\n", level, cg)
		fmt.Fprintf(&b, "    meta mark set 0x%x\n", LinuxMark)
	}
	b.WriteString("  }\n")
	fmt.Fprintf(&b, "  chain nat_post {\n    type nat hook postrouting priority srcnat; policy accept;\n    meta mark 0x%x oifname != \"%s\" masquerade\n  }\n}\n", LinuxMark, tun)
	return b.String(), nil
}

// RouteInfo — маршрут к серверу в обход туннеля.
type RouteInfo struct {
	Dev     string
	Gateway string
}

// ParseRouteGet разбирает вывод `ip -j -4 route get <addr>`.
func ParseRouteGet(out []byte) (RouteInfo, error) {
	var rows []struct {
		Dev     string `json:"dev"`
		Gateway string `json:"gateway"`
	}
	if err := json.Unmarshal(out, &rows); err != nil || len(rows) == 0 || rows[0].Dev == "" {
		return RouteInfo{}, errors.New("не удалось определить маршрут к серверу")
	}
	r := RouteInfo{Dev: rows[0].Dev, Gateway: rows[0].Gateway}
	if strings.ContainsAny(r.Dev, " \t/\\;") {
		return RouteInfo{}, errors.New("недопустимое имя интерфейса")
	}
	return r, nil
}

// ParseProcStat извлекает PPID и время запуска (в тиках) из содержимого /proc/<pid>/stat.
// Имя процесса в скобках может содержать пробелы и скобки, поэтому ищется последняя «)».
func ParseProcStat(content string) (ppid uint32, start uint64, err error) {
	i := strings.LastIndex(content, ")")
	if i < 0 {
		return 0, 0, errors.New("неверный формат stat")
	}
	f := strings.Fields(content[i+1:])
	// f[0]=state, f[1]=ppid, ..., f[19]=starttime
	if len(f) < 20 {
		return 0, 0, errors.New("неверный формат stat")
	}
	pp, err := strconv.ParseUint(f[1], 10, 32)
	if err != nil {
		return 0, 0, err
	}
	st, err := strconv.ParseUint(f[19], 10, 64)
	if err != nil {
		return 0, 0, err
	}
	return uint32(pp), st, nil
}

// ParseCgroupV2 возвращает путь cgroup v2 из содержимого /proc/<pid>/cgroup («0::/user.slice/…»).
func ParseCgroupV2(content string) (string, bool) {
	for _, l := range strings.Split(content, "\n") {
		if strings.HasPrefix(l, "0::") {
			p := strings.TrimPrefix(l, "0::")
			p = strings.TrimSuffix(p, " (deleted)")
			if strings.HasPrefix(p, "/") && !strings.Contains(p, "..") {
				return p, true
			}
		}
	}
	return "", false
}
