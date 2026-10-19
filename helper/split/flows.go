package split

import (
	"sync"
	"time"
)

// Decision — куда отправлять трафик сокета.
type Decision uint8

const (
	DecisionUnknown Decision = iota
	DecisionTunnel           // через VPN (поведение по умолчанию)
	DecisionBypass           // мимо VPN
)

type FlowKey struct {
	Proto     uint8
	LocalPort uint16
}

type flowEntry struct {
	decision Decision
	pid      uint32
	seen     time.Time
}

// FlowTable хранит решения по локальным сокетам (по протоколу и локальному порту).
type FlowTable struct {
	mu      sync.Mutex
	entries map[FlowKey]*flowEntry
	ttl     time.Duration
	max     int
}

func NewFlowTable(ttl time.Duration, max int) *FlowTable {
	return &FlowTable{entries: make(map[FlowKey]*flowEntry), ttl: ttl, max: max}
}

func (t *FlowTable) Set(k FlowKey, d Decision, pid uint32, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.entries[k]; !ok && len(t.entries) >= t.max {
		t.gcLocked(now)
		if len(t.entries) >= t.max {
			return // таблица переполнена: неизвестные потоки пойдут через VPN (безопасно)
		}
	}
	t.entries[k] = &flowEntry{decision: d, pid: pid, seen: now}
}

// Get возвращает решение и продлевает запись.
func (t *FlowTable) Get(k FlowKey, now time.Time) (Decision, uint32) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.entries[k]
	if !ok || now.Sub(e.seen) > t.ttl {
		if ok {
			delete(t.entries, k)
		}
		return DecisionUnknown, 0
	}
	e.seen = now
	return e.decision, e.pid
}

func (t *FlowTable) Delete(k FlowKey) {
	t.mu.Lock()
	delete(t.entries, k)
	t.mu.Unlock()
}

func (t *FlowTable) Len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.entries)
}

func (t *FlowTable) GC(now time.Time) {
	t.mu.Lock()
	t.gcLocked(now)
	t.mu.Unlock()
}

func (t *FlowTable) gcLocked(now time.Time) {
	for k, e := range t.entries {
		if now.Sub(e.seen) > t.ttl {
			delete(t.entries, k)
		}
	}
}

// NATKey идентифицирует преобразованное соединение со стороны физического интерфейса.
type NATKey struct {
	Proto      uint8
	LocalPort  uint16
	RemoteIP   [4]byte
	RemotePort uint16
}

type natEntry struct {
	tunIP   [4]byte
	seen    time.Time
	closing bool
}

// NATTable хранит активные преобразования адресов источника.
type NATTable struct {
	mu         sync.Mutex
	entries    map[NATKey]*natEntry
	tcpTTL     time.Duration
	udpTTL     time.Duration
	closingTTL time.Duration
	max        int
}

func NewNATTable(tcpTTL, udpTTL, closingTTL time.Duration, max int) *NATTable {
	return &NATTable{entries: make(map[NATKey]*natEntry), tcpTTL: tcpTTL, udpTTL: udpTTL, closingTTL: closingTTL, max: max}
}

func (t *NATTable) ttl(k NATKey, e *natEntry) time.Duration {
	switch {
	case e.closing:
		return t.closingTTL
	case k.Proto == ProtoUDP:
		return t.udpTTL
	default:
		return t.tcpTTL
	}
}

// Touch создаёт или обновляет запись; closing=true помечает завершающееся TCP-соединение.
// Возвращает false, если таблица переполнена (пакет следует оставить в туннеле).
func (t *NATTable) Touch(k NATKey, tunIP [4]byte, closing bool, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.entries[k]
	if !ok {
		if len(t.entries) >= t.max {
			t.gcLocked(now)
			if len(t.entries) >= t.max {
				return false
			}
		}
		e = &natEntry{tunIP: tunIP}
		t.entries[k] = e
	}
	e.seen = now
	e.tunIP = tunIP
	if closing {
		e.closing = true
	}
	return true
}

// Lookup возвращает исходный адрес в туннеле для ответного пакета.
func (t *NATTable) Lookup(k NATKey, closing bool, now time.Time) ([4]byte, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.entries[k]
	if !ok {
		return [4]byte{}, false
	}
	if now.Sub(e.seen) > t.ttl(k, e) {
		delete(t.entries, k)
		return [4]byte{}, false
	}
	e.seen = now
	if closing {
		e.closing = true
	}
	return e.tunIP, true
}

func (t *NATTable) Len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.entries)
}

func (t *NATTable) GC(now time.Time) {
	t.mu.Lock()
	t.gcLocked(now)
	t.mu.Unlock()
}

func (t *NATTable) gcLocked(now time.Time) {
	for k, e := range t.entries {
		if now.Sub(e.seen) > t.ttl(k, e) {
			delete(t.entries, k)
		}
	}
}
