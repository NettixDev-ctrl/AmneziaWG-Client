package split

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// Params — параметры запуска движка.
type Params struct {
	Mode       Mode
	Apps       []string // полные пути к .exe
	TunName    string   // имя адаптера туннеля
	EndpointIP *[4]byte // адрес сервера AWG: его пакеты не перехватываются
	DLLPath    string   // абсолютный путь к WinDivert.dll
	Logf       func(format string, args ...any)
}

// Engine — запущенный движок раздельного туннелирования.
type Engine struct {
	p    Params
	lib  *divertLib
	core *Core

	stop     chan struct{}
	done     chan struct{}
	stopOnce sync.Once

	mu     sync.Mutex
	state  string // starting | running | failed
	errMsg string

	rewritten atomic.Uint64
}

const packetBufSize = 65535 + 40

func Start(p Params) (*Engine, error) {
	if !p.Mode.Valid() || p.Mode == ModeAll {
		return nil, errors.New("недопустимый режим раздельного туннелирования")
	}
	if p.Logf == nil {
		p.Logf = func(string, ...any) {}
	}
	lib, err := loadDivert(p.DLLPath)
	if err != nil {
		return nil, err
	}
	matcher, err := NewMatcher(p.Apps, newProcProvider(), 30*time.Second)
	if err != nil {
		lib.dll.Release()
		return nil, err
	}
	e := &Engine{p: p, lib: lib, stop: make(chan struct{}), done: make(chan struct{}), state: "starting"}

	tun, err := tunnelInterface(p.TunName)
	if err != nil {
		lib.dll.Release()
		return nil, err
	}
	phys, err := physicalInterface(tun.Index)
	if err != nil {
		lib.dll.Release()
		return nil, err
	}
	e.core = NewCore(p.Mode, tun.IP, phys.IP, matcher)

	sock, err := lib.Open("(event == BIND or event == CONNECT or event == CLOSE) and ip and (tcp or udp)", layerSocket, 0, flagSniff|flagRecvOnly)
	if err != nil {
		lib.dll.Release()
		return nil, err
	}
	sess, err := e.openSession(tun, phys)
	if err != nil {
		sock.Close()
		lib.dll.Release()
		return nil, err
	}
	e.setState("running", "")
	go e.supervise(sock, sess, tun)
	return e, nil
}

type session struct {
	out, in *divertHandle
	tun     ifaceInfo
	phys    ifaceInfo
	wg      sync.WaitGroup
}

func (e *Engine) openSession(tun, phys ifaceInfo) (*session, error) {
	e.core.PhysIP = phys.IP
	outFilter := fmt.Sprintf("outbound and ifIdx == %d and ip and (tcp or udp)", tun.Index)
	inFilter := fmt.Sprintf("inbound and ifIdx == %d and ip and (tcp or udp) and ip.DstAddr == %d.%d.%d.%d",
		phys.Index, phys.IP[0], phys.IP[1], phys.IP[2], phys.IP[3])
	if ep := e.p.EndpointIP; ep != nil {
		inFilter += fmt.Sprintf(" and ip.SrcAddr != %d.%d.%d.%d", ep[0], ep[1], ep[2], ep[3])
	}
	out, err := e.lib.Open(outFilter, layerNetwork, 0, 0)
	if err != nil {
		return nil, err
	}
	in, err := e.lib.Open(inFilter, layerNetwork, 0, 0)
	if err != nil {
		out.Close()
		return nil, err
	}
	s := &session{out: out, in: in, tun: tun, phys: phys}
	s.wg.Add(2)
	go func() { defer s.wg.Done(); e.packetLoop(out, true, s) }()
	go func() { defer s.wg.Done(); e.packetLoop(in, false, s) }()
	e.p.Logf("раздельное туннелирование: туннель if=%d, физический if=%d", tun.Index, phys.Index)
	return s, nil
}

func (s *session) close() {
	s.out.Shutdown()
	s.in.Shutdown()
	s.wg.Wait()
	s.out.Close()
	s.in.Close()
}

// packetLoop читает пакеты, принимает решение и возвращает их в сеть (изменёнными или как есть).
func (e *Engine) packetLoop(h *divertHandle, outbound bool, s *session) {
	buf := make([]byte, packetBufSize)
	var addr address
	for {
		n, err := h.Recv(buf, &addr)
		if err != nil {
			if errors.Is(err, errShutdown) {
				return
			}
			e.p.Logf("ошибка чтения пакетов: %v", err)
			e.fail(fmt.Sprintf("ошибка WinDivert: %v", err))
			return
		}
		pkt := buf[:n]
		now := time.Now()
		var act Action
		if outbound {
			act = e.core.HandleOutbound(pkt, now)
		} else {
			act = e.core.HandleInbound(pkt, now)
		}
		if act == ActionRewritten {
			e.rewritten.Add(1)
			if outbound {
				addr.setIfIdx(s.phys.Index) // наружу — через физический интерфейс
				addr.setOutbound(true)
			} else {
				addr.setIfIdx(s.tun.Index) // ответ доставляется «из туннеля»
				addr.setOutbound(false)
			}
			addr.markChecksumsValid()
		}
		if err := h.Send(pkt, &addr); err != nil {
			e.core.Stats.Errors.Add(1)
		}
	}
}

// supervise обрабатывает события сокетов, чистит таблицы и следит за сменой физического интерфейса.
func (e *Engine) supervise(sock *divertHandle, sess *session, tun ifaceInfo) {
	defer close(e.done)
	sockDone := make(chan struct{})
	go func() {
		defer close(sockDone)
		buf := make([]byte, 64)
		var addr address
		for {
			_, err := sock.Recv(buf, &addr)
			if err != nil {
				if !errors.Is(err, errShutdown) {
					e.fail(fmt.Sprintf("ошибка WinDivert (сокеты): %v", err))
				}
				return
			}
			pid, port, proto := addr.socketData()
			var kind SocketEventKind
			switch addr.event() {
			case eventSocketBind:
				kind = SocketBind
			case eventSocketConnect:
				kind = SocketConnect
			case eventSocketClose:
				kind = SocketClose
			default:
				continue
			}
			e.core.OnSocketEvent(SocketEvent{Kind: kind, PID: pid, Proto: proto, LocalPort: port}, time.Now())
		}
	}()

	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-e.stop:
			sess.close()
			sock.Shutdown()
			<-sockDone
			sock.Close()
			e.lib.dll.Release()
			return
		case <-sockDone:
			sess.close()
			sock.Close()
			e.lib.dll.Release()
			return
		case <-tick.C:
			e.core.GC(time.Now())
			phys, err := physicalInterface(tun.Index)
			if err != nil || (phys.Index == sess.phys.Index && phys.IP == sess.phys.IP) {
				continue
			}
			// Сменился основной сетевой интерфейс (Wi‑Fi ↔ Ethernet и т.п.): перезапускаем перехват.
			e.p.Logf("раздельное туннелирование: сменился физический интерфейс (%d → %d)", sess.phys.Index, phys.Index)
			sess.close()
			e.core.NAT = NewNATTable(30*time.Minute, 2*time.Minute, 30*time.Second, 1<<16)
			ns, err := e.openSession(tun, phys)
			if err != nil {
				e.fail(fmt.Sprintf("не удалось перезапустить перехват: %v", err))
				sock.Shutdown()
				<-sockDone
				sock.Close()
				e.lib.dll.Release()
				return
			}
			sess = ns
		}
	}
}

func (e *Engine) setState(s, msg string) {
	e.mu.Lock()
	e.state, e.errMsg = s, msg
	e.mu.Unlock()
}

func (e *Engine) fail(msg string) {
	e.setState("failed", msg)
	e.Stop()
}

// Stop останавливает движок; повторные вызовы безопасны.
func (e *Engine) Stop() {
	e.stopOnce.Do(func() { close(e.stop) })
}

// Wait блокируется до полной остановки.
func (e *Engine) Wait() { <-e.done }

// Status возвращает состояние, сообщение об ошибке и число отслеживаемых потоков.
func (e *Engine) Status() (state, errMsg string, flows int) {
	e.mu.Lock()
	state, errMsg = e.state, e.errMsg
	e.mu.Unlock()
	return state, errMsg, e.core.Flows.Len()
}
