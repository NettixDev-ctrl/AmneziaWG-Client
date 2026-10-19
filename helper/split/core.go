package split

import (
	"sync/atomic"
	"time"
)

// Action — что сделать с перехваченным пакетом.
type Action uint8

const (
	// ActionPass — вернуть пакет без изменений (он продолжит путь по умолчанию).
	ActionPass Action = iota
	// ActionRewritten — пакет изменён; для исходящих его нужно отправить через физический
	// интерфейс, для входящих — доставить на интерфейс туннеля.
	ActionRewritten
)

// SocketEvent — событие создания/закрытия сокета (WinDivert SOCKET layer).
type SocketEvent struct {
	Kind      SocketEventKind
	PID       uint32
	Proto     uint8
	LocalPort uint16
}

type SocketEventKind uint8

const (
	SocketBind SocketEventKind = iota
	SocketConnect
	SocketClose
)

// Stats — счётчики для диагностики (без содержимого трафика).
type Stats struct {
	OutboundSeen      atomic.Uint64
	OutboundRewritten atomic.Uint64
	InboundSeen       atomic.Uint64
	InboundRewritten  atomic.Uint64
	Unknown           atomic.Uint64
	Errors            atomic.Uint64
}

// Core — платформенно-независимая логика принятия решений и подмены адресов.
type Core struct {
	Mode    Mode
	TunIP   [4]byte
	PhysIP  [4]byte
	Matcher *Matcher
	Flows   *FlowTable
	NAT     *NATTable
	Stats   Stats
}

func NewCore(mode Mode, tunIP, physIP [4]byte, m *Matcher) *Core {
	return &Core{
		Mode: mode, TunIP: tunIP, PhysIP: physIP, Matcher: m,
		Flows: NewFlowTable(30*time.Minute, 1<<16),
		NAT:   NewNATTable(30*time.Minute, 2*time.Minute, 30*time.Second, 1<<16),
	}
}

// decide переводит принадлежность процесса к списку в решение по режиму.
func (c *Core) decide(pid uint32, now time.Time) Decision {
	if pid == 0 {
		return DecisionTunnel
	}
	listed := c.Matcher.Matches(pid, now)
	switch c.Mode {
	case ModeBypass:
		if listed {
			return DecisionBypass
		}
	case ModeInclude:
		if !listed {
			return DecisionBypass
		}
	}
	return DecisionTunnel
}

// OnSocketEvent обновляет таблицу потоков.
func (c *Core) OnSocketEvent(ev SocketEvent, now time.Time) {
	key := FlowKey{Proto: ev.Proto, LocalPort: ev.LocalPort}
	if ev.Proto != ProtoTCP && ev.Proto != ProtoUDP {
		return
	}
	switch ev.Kind {
	case SocketBind, SocketConnect:
		c.Flows.Set(key, c.decide(ev.PID, now), ev.PID, now)
	case SocketClose:
		c.Flows.Delete(key)
	}
}

// HandleOutbound обрабатывает пакет, уходящий в интерфейс туннеля. Если решение — «мимо VPN»,
// пакет изменяется на месте (адрес источника → адрес физического интерфейса).
func (c *Core) HandleOutbound(buf []byte, now time.Time) Action {
	c.Stats.OutboundSeen.Add(1)
	p, err := ParseIPv4(buf)
	if err != nil {
		return ActionPass
	}
	if p.Src() != c.TunIP {
		return ActionPass
	}
	d, _ := c.Flows.Get(FlowKey{Proto: p.Proto, LocalPort: p.SrcPort()}, now)
	if d == DecisionUnknown {
		c.Stats.Unknown.Add(1)
		return ActionPass
	}
	if d != DecisionBypass {
		return ActionPass
	}
	closing := p.TCPFlags()&(TCPFin|TCPRst) != 0
	key := NATKey{Proto: p.Proto, LocalPort: p.SrcPort(), RemoteIP: p.Dst(), RemotePort: p.DstPort()}
	if !c.NAT.Touch(key, c.TunIP, closing, now) {
		c.Stats.Errors.Add(1)
		return ActionPass
	}
	p.SetSrc(c.PhysIP)
	p.FixChecksums()
	c.Stats.OutboundRewritten.Add(1)
	return ActionRewritten
}

// HandleInbound обрабатывает пакет, пришедший на физический интерфейс. Если это ответ на
// преобразованное соединение, адрес назначения возвращается к адресу в туннеле.
func (c *Core) HandleInbound(buf []byte, now time.Time) Action {
	c.Stats.InboundSeen.Add(1)
	p, err := ParseIPv4(buf)
	if err != nil {
		return ActionPass
	}
	if p.Dst() != c.PhysIP {
		return ActionPass
	}
	key := NATKey{Proto: p.Proto, LocalPort: p.DstPort(), RemoteIP: p.Src(), RemotePort: p.SrcPort()}
	closing := p.TCPFlags()&(TCPFin|TCPRst) != 0
	tunIP, ok := c.NAT.Lookup(key, closing, now)
	if !ok {
		return ActionPass
	}
	p.SetDst(tunIP)
	p.FixChecksums()
	c.Stats.InboundRewritten.Add(1)
	return ActionRewritten
}

// GC удаляет устаревшие записи.
func (c *Core) GC(now time.Time) {
	c.Flows.GC(now)
	c.NAT.GC(now)
}
