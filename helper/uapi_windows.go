//go:build windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Microsoft/go-winio"
)

// tunnelUAPIPath — канал управления внутри службы туннеля (amneziawg-go UAPI).
const tunnelUAPIPath = `\\.\pipe\ProtectedPrefix\Administrators\AmneziaWG\` + tunnelName

type tunnelStats struct {
	LastHandshake time.Time // нулевое значение — рукопожатия не было
	Rx, Tx        uint64
}

// queryTunnel читает «get=1» у работающего туннеля: время рукопожатия и счётчики трафика.
// Значения ключей в ответ не попадают в журнал (в ответе есть секреты).
func queryTunnel() (*tunnelStats, error) {
	timeout := 2 * time.Second
	conn, err := winio.DialPipe(tunnelUAPIPath, &timeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte("get=1\n\n")); err != nil {
		return nil, err
	}
	st := &tunnelStats{}
	var sec, nsec int64
	sc := bufio.NewScanner(conn)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			break
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch k {
		case "errno":
			if v != "0" {
				return nil, fmt.Errorf("uapi errno=%s", v)
			}
		case "last_handshake_time_sec":
			n, _ := strconv.ParseInt(v, 10, 64)
			if n > sec {
				sec = n
				nsec = 0
			}
		case "last_handshake_time_nsec":
			nsec, _ = strconv.ParseInt(v, 10, 64)
		case "rx_bytes":
			n, _ := strconv.ParseUint(v, 10, 64)
			st.Rx += n
		case "tx_bytes":
			n, _ := strconv.ParseUint(v, 10, 64)
			st.Tx += n
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if sec > 0 {
		st.LastHandshake = time.Unix(sec, nsec)
	}
	if st.LastHandshake.After(time.Now().Add(time.Minute)) {
		return nil, errors.New("некорректное время рукопожатия")
	}
	return st, nil
}
