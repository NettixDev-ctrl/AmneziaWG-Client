package split

import (
	"encoding/binary"
	"testing"
	"time"
)

type fakeProcs map[uint32]ProcInfo

func (f fakeProcs) Info(pid uint32) (ProcInfo, bool) { i, ok := f[pid]; return i, ok }

func buildPacket(proto uint8, src, dst [4]byte, sport, dport uint16, flags byte, payload []byte) []byte {
	var l4 []byte
	if proto == ProtoTCP {
		l4 = make([]byte, 20+len(payload))
		binary.BigEndian.PutUint16(l4[0:], sport)
		binary.BigEndian.PutUint16(l4[2:], dport)
		l4[12] = 5 << 4
		l4[13] = flags
		copy(l4[20:], payload)
	} else {
		l4 = make([]byte, 8+len(payload))
		binary.BigEndian.PutUint16(l4[0:], sport)
		binary.BigEndian.PutUint16(l4[2:], dport)
		binary.BigEndian.PutUint16(l4[4:], uint16(8+len(payload)))
		copy(l4[8:], payload)
	}
	b := make([]byte, 20+len(l4))
	b[0] = 0x45
	binary.BigEndian.PutUint16(b[2:], uint16(len(b)))
	b[8] = 64
	b[9] = proto
	copy(b[12:], src[:])
	copy(b[16:], dst[:])
	copy(b[20:], l4)
	p, err := ParseIPv4(b)
	if err != nil {
		panic(err)
	}
	p.FixChecksums()
	return b
}

var (
	tunIP  = [4]byte{10, 61, 0, 6}
	physIP = [4]byte{192, 168, 1, 50}
	remote = [4]byte{93, 184, 216, 34}
)

const (
	chrome  = `C:\Program Files\Google\Chrome\Application\chrome.exe`
	firefox = `C:\Program Files\Mozilla Firefox\firefox.exe`
)

func newCore(t *testing.T, mode Mode, apps ...string) *Core {
	t.Helper()
	procs := fakeProcs{
		100: {Path: chrome, ParentPID: 1, CreateTime: 10},
		101: {Path: `C:\Program Files\Google\Chrome\Application\chrome.exe`, ParentPID: 100, CreateTime: 20}, // тот же образ
		102: {Path: `C:\Windows\System32\helper.exe`, ParentPID: 100, CreateTime: 30},                        // потомок
		200: {Path: firefox, ParentPID: 1, CreateTime: 10},
		300: {Path: `C:\Windows\System32\svchost.exe`, ParentPID: 1, CreateTime: 5},
		1:   {Path: `C:\Windows\explorer.exe`, ParentPID: 0, CreateTime: 1},
		// «родитель» создан позже потомка — PID переиспользован, наследование недопустимо
		400: {Path: `C:\x\child.exe`, ParentPID: 401, CreateTime: 10},
		401: {Path: chrome, ParentPID: 1, CreateTime: 50},
	}
	m, err := NewMatcher(apps, procs, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return NewCore(mode, tunIP, physIP, m)
}

func TestChecksumsAfterRewrite(t *testing.T) {
	for _, proto := range []uint8{ProtoTCP, ProtoUDP} {
		b := buildPacket(proto, tunIP, remote, 50000, 443, TCPSyn, []byte("hello world!"))
		p, _ := ParseIPv4(b)
		if !p.VerifyChecksums() {
			t.Fatalf("proto %d: исходные суммы неверны", proto)
		}
		p.SetSrc(physIP)
		if p.VerifyChecksums() {
			t.Fatalf("proto %d: после подмены без пересчёта суммы должны быть неверны", proto)
		}
		p.FixChecksums()
		if !p.VerifyChecksums() || p.Src() != physIP {
			t.Fatalf("proto %d: пересчёт не помог", proto)
		}
	}
}

func TestParseRejectsBadPackets(t *testing.T) {
	good := buildPacket(ProtoTCP, tunIP, remote, 1, 2, 0, nil)
	cases := map[string][]byte{
		"короткий":     good[:10],
		"не ipv4":      append([]byte{0x60}, good[1:]...),
		"обрезан":      good[:25],
		"icmp":         func() []byte { b := append([]byte{}, good...); b[9] = 1; return b }(),
		"фрагмент":     func() []byte { b := append([]byte{}, good...); b[6] = 0x20; return b }(),
		"ihl<20":       func() []byte { b := append([]byte{}, good...); b[0] = 0x44; return b }(),
		"длина>буфера": func() []byte { b := append([]byte{}, good...); binary.BigEndian.PutUint16(b[2:], 9999); return b }(),
	}
	for name, b := range cases {
		if _, err := ParseIPv4(b); err == nil {
			t.Errorf("%s: ожидалась ошибка", name)
		}
	}
}

func TestBypassMode_ListedAppGoesDirect(t *testing.T) {
	c := newCore(t, ModeBypass, chrome)
	now := time.Now()
	c.OnSocketEvent(SocketEvent{Kind: SocketConnect, PID: 100, Proto: ProtoTCP, LocalPort: 50000}, now)
	c.OnSocketEvent(SocketEvent{Kind: SocketConnect, PID: 300, Proto: ProtoTCP, LocalPort: 50001}, now)

	out := buildPacket(ProtoTCP, tunIP, remote, 50000, 443, TCPSyn, nil)
	if c.HandleOutbound(out, now) != ActionRewritten {
		t.Fatal("пакет chrome должен идти мимо VPN")
	}
	p, _ := ParseIPv4(out)
	if p.Src() != physIP || !p.VerifyChecksums() {
		t.Fatal("адрес источника не подменён или суммы неверны")
	}

	other := buildPacket(ProtoTCP, tunIP, remote, 50001, 443, TCPSyn, nil)
	orig := append([]byte{}, other...)
	if c.HandleOutbound(other, now) != ActionPass || string(other) != string(orig) {
		t.Fatal("svchost должен остаться в туннеле без изменений")
	}

	reply := buildPacket(ProtoTCP, remote, physIP, 443, 50000, TCPSyn|0x10, nil)
	if c.HandleInbound(reply, now) != ActionRewritten {
		t.Fatal("ответ должен быть возвращён в туннельный адрес")
	}
	rp, _ := ParseIPv4(reply)
	if rp.Dst() != tunIP || !rp.VerifyChecksums() {
		t.Fatal("адрес назначения не восстановлен")
	}
}

func TestIncludeMode_OnlyListedViaTunnel(t *testing.T) {
	c := newCore(t, ModeInclude, firefox)
	now := time.Now()
	c.OnSocketEvent(SocketEvent{Kind: SocketConnect, PID: 200, Proto: ProtoUDP, LocalPort: 6000}, now)
	c.OnSocketEvent(SocketEvent{Kind: SocketConnect, PID: 300, Proto: ProtoUDP, LocalPort: 6001}, now)

	listed := buildPacket(ProtoUDP, tunIP, remote, 6000, 53, 0, []byte("q"))
	if c.HandleOutbound(listed, now) != ActionPass {
		t.Fatal("выбранное приложение должно остаться в туннеле")
	}
	rest := buildPacket(ProtoUDP, tunIP, remote, 6001, 53, 0, []byte("q"))
	if c.HandleOutbound(rest, now) != ActionRewritten {
		t.Fatal("остальные приложения должны идти мимо VPN")
	}
}

func TestChildProcessesInheritRule(t *testing.T) {
	c := newCore(t, ModeBypass, chrome)
	now := time.Now()
	for _, pid := range []uint32{101, 102} {
		if !c.Matcher.Matches(pid, now) {
			t.Fatalf("pid %d должен наследовать правило", pid)
		}
	}
	if c.Matcher.Matches(300, now) {
		t.Fatal("svchost не должен совпадать")
	}
	if c.Matcher.Matches(400, now) {
		t.Fatal("защита от переиспользования PID не сработала")
	}
}

func TestMatchingByFullPathNotName(t *testing.T) {
	procs := fakeProcs{1: {Path: `D:\portable\chrome.exe`}}
	m, _ := NewMatcher([]string{chrome}, procs, time.Minute)
	if m.Matches(1, time.Now()) {
		t.Fatal("одноимённый exe из другой папки не должен совпадать")
	}
	m2, _ := NewMatcher([]string{`d:/PORTABLE/Chrome.EXE`}, procs, time.Minute)
	if !m2.Matches(1, time.Now()) {
		t.Fatal("сравнение путей должно быть нечувствительно к регистру и слешам")
	}
}

func TestUnknownFlowsStayInTunnel(t *testing.T) {
	c := newCore(t, ModeInclude, firefox)
	pkt := buildPacket(ProtoTCP, tunIP, remote, 55555, 443, TCPSyn, nil)
	if c.HandleOutbound(pkt, time.Now()) != ActionPass || c.Stats.Unknown.Load() != 1 {
		t.Fatal("поток без записи должен оставаться в туннеле (безопасное поведение по умолчанию)")
	}
}

func TestForeignSourceAndInboundWithoutNAT(t *testing.T) {
	c := newCore(t, ModeBypass, chrome)
	now := time.Now()
	c.OnSocketEvent(SocketEvent{Kind: SocketConnect, PID: 100, Proto: ProtoTCP, LocalPort: 50000}, now)
	foreign := buildPacket(ProtoTCP, [4]byte{10, 9, 9, 9}, remote, 50000, 443, 0, nil)
	if c.HandleOutbound(foreign, now) != ActionPass {
		t.Fatal("пакеты с чужим адресом источника трогать нельзя")
	}
	in := buildPacket(ProtoTCP, remote, physIP, 443, 50000, 0, nil)
	if c.HandleInbound(in, now) != ActionPass {
		t.Fatal("входящий пакет без записи NAT должен пройти без изменений")
	}
	toOther := buildPacket(ProtoTCP, remote, [4]byte{192, 168, 1, 99}, 443, 50000, 0, nil)
	if c.HandleInbound(toOther, now) != ActionPass {
		t.Fatal("чужой адрес назначения")
	}
}

func TestSocketCloseAndExpiry(t *testing.T) {
	c := newCore(t, ModeBypass, chrome)
	now := time.Now()
	c.OnSocketEvent(SocketEvent{Kind: SocketBind, PID: 100, Proto: ProtoUDP, LocalPort: 7000}, now)
	c.OnSocketEvent(SocketEvent{Kind: SocketClose, PID: 100, Proto: ProtoUDP, LocalPort: 7000}, now)
	if d, _ := c.Flows.Get(FlowKey{ProtoUDP, 7000}, now); d != DecisionUnknown {
		t.Fatal("после закрытия сокета запись должна исчезнуть")
	}
	// запись NAT для UDP живёт недолго
	out := buildPacket(ProtoUDP, tunIP, remote, 7001, 53, 0, nil)
	c.OnSocketEvent(SocketEvent{Kind: SocketBind, PID: 100, Proto: ProtoUDP, LocalPort: 7001}, now)
	c.HandleOutbound(out, now)
	late := now.Add(3 * time.Minute)
	in := buildPacket(ProtoUDP, remote, physIP, 53, 7001, 0, nil)
	if c.HandleInbound(in, late) != ActionPass {
		t.Fatal("устаревшая запись NAT не должна применяться")
	}
}

func TestTableLimits(t *testing.T) {
	n := NewNATTable(time.Minute, time.Minute, time.Second, 2)
	now := time.Now()
	if !n.Touch(NATKey{Proto: 6, LocalPort: 1}, tunIP, false, now) || !n.Touch(NATKey{Proto: 6, LocalPort: 2}, tunIP, false, now) {
		t.Fatal("первые записи должны добавляться")
	}
	if n.Touch(NATKey{Proto: 6, LocalPort: 3}, tunIP, false, now) {
		t.Fatal("переполненная таблица не должна расти")
	}
	if !n.Touch(NATKey{Proto: 6, LocalPort: 3}, tunIP, false, now.Add(2*time.Minute)) {
		t.Fatal("после истечения места должно хватить")
	}
}

func TestNormalizePath(t *testing.T) {
	good := map[string]string{
		`C:\Program Files\A\a.exe`: `c:\program files\a\a.exe`,
		`c:/x/Y.EXE`:               `c:\x\y.exe`,
		`\\?\C:\x\y.exe`:           `c:\x\y.exe`,
		`\\srv\share\y.exe`:        `\\srv\share\y.exe`,
	}
	for in, want := range good {
		got, err := NormalizePath(in)
		if err != nil || got != want {
			t.Errorf("%q → %q, %v (ожидалось %q)", in, got, err, want)
		}
	}
	for _, bad := range []string{``, `a.exe`, `C:\a\..\b.exe`, `C:\a\b.txt`, `C:\a\*.exe`, `\\.\pipe\x.exe`, `C:\a\b|c.exe`} {
		if _, err := NormalizePath(bad); err == nil {
			t.Errorf("%q должен быть отклонён", bad)
		}
	}
}

func TestPosixPathsAndCase(t *testing.T) {
	for in, want := range map[string]string{"/usr/bin/firefox": "/usr/bin/firefox", "/opt//App/run/": "/opt/App/run"} {
		got, err := NormalizePath(in)
		if err != nil || got != want {
			t.Errorf("%q → %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"/", "/a/../b", "/a/*", "/a/\x01"} {
		if _, err := NormalizePath(bad); err == nil {
			t.Errorf("%q должен быть отклонён", bad)
		}
	}
	procs := fakeProcs{1: {Path: "/usr/bin/App (deleted)"}, 2: {Path: "/usr/bin/app"}}
	m, _ := NewMatcher([]string{"/usr/bin/App"}, procs, time.Minute)
	if !m.Matches(1, time.Now()) {
		t.Fatal("удалённый образ должен совпадать")
	}
	if m.Matches(2, time.Now()) {
		t.Fatal("регистр в POSIX значим")
	}
}
