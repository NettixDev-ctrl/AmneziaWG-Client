package main

import (
	"errors"
	"strconv"
	"strings"
	"time"
)

// Dump — разобранный вывод «awg show <iface> dump».
type Dump struct {
	FwMark        uint32
	LastHandshake time.Time // нулевое значение — рукопожатия не было
	Rx, Tx        uint64
}

// ParseAwgDump разбирает вывод `awg show <iface> dump`: первая строка — интерфейс
// (private-key public-key listen-port fwmark), далее по строке на пира
// (public-key preshared-key endpoint allowed-ips latest-handshake rx tx keepalive).
// Значения ключей не сохраняются.
func ParseAwgDump(s string) (*Dump, error) {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) == 0 || lines[0] == "" {
		return nil, errors.New("пустой вывод awg")
	}
	d := &Dump{}
	head := strings.Split(lines[0], "\t")
	if len(head) >= 4 && head[3] != "off" {
		if v, err := strconv.ParseUint(head[3], 0, 32); err == nil {
			d.FwMark = uint32(v)
		}
	}
	var best int64
	for _, l := range lines[1:] {
		f := strings.Split(l, "\t")
		if len(f) < 7 {
			continue
		}
		if hs, err := strconv.ParseInt(f[4], 10, 64); err == nil && hs > best {
			best = hs
		}
		if rx, err := strconv.ParseUint(f[5], 10, 64); err == nil {
			d.Rx += rx
		}
		if tx, err := strconv.ParseUint(f[6], 10, 64); err == nil {
			d.Tx += tx
		}
	}
	if best > 0 {
		d.LastHandshake = time.Unix(best, 0)
	}
	return d, nil
}
