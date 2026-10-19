// Package split реализует раздельное туннелирование по процессам.
//
// Принцип работы (см. README, раздел «Раздельное туннелирование»): туннель всегда настроен как
// полный (маршруты 0/0 через адаптер AWG). Пакеты приложений, которые должны идти МИМО VPN,
// перехватываются на сетевом уровне (WinDivert), у них подменяется адрес источника на адрес
// физического адаптера и они отправляются через физический интерфейс; ответы подменяются
// обратно. Решение «мимо VPN / через VPN» принимается по процессу-владельцу сокета.
//
// Этот файл и соседние platform-independent файлы не зависят от Windows и покрыты тестами.
package split

import (
	"encoding/binary"
	"errors"
)

const (
	ProtoTCP uint8 = 6
	ProtoUDP uint8 = 17
)

var (
	ErrNotIPv4      = errors.New("не IPv4-пакет")
	ErrTruncated    = errors.New("пакет обрезан")
	ErrFragment     = errors.New("фрагментированный пакет не поддерживается")
	ErrUnsupported  = errors.New("протокол не поддерживается")
	ErrBadChecksumL = errors.New("неверная длина заголовка транспортного уровня")
)

// IPv4Packet — представление пакета поверх изменяемого буфера.
type IPv4Packet struct {
	B     []byte // весь пакет (только IP-часть, без кадра Ethernet)
	IHL   int    // длина IP-заголовка в байтах
	Proto uint8
	total int
}

// ParseIPv4 проверяет заголовок и возвращает представление пакета. Фрагменты отвергаются.
func ParseIPv4(b []byte) (*IPv4Packet, error) {
	if len(b) < 20 {
		return nil, ErrTruncated
	}
	if b[0]>>4 != 4 {
		return nil, ErrNotIPv4
	}
	ihl := int(b[0]&0x0f) * 4
	if ihl < 20 || len(b) < ihl {
		return nil, ErrTruncated
	}
	total := int(binary.BigEndian.Uint16(b[2:4]))
	if total < ihl || total > len(b) {
		return nil, ErrTruncated
	}
	frag := binary.BigEndian.Uint16(b[6:8])
	if frag&0x3fff != 0 { // MF или смещение фрагмента
		return nil, ErrFragment
	}
	p := &IPv4Packet{B: b[:total], IHL: ihl, Proto: b[9], total: total}
	switch p.Proto {
	case ProtoTCP:
		if total-ihl < 20 {
			return nil, ErrTruncated
		}
	case ProtoUDP:
		if total-ihl < 8 {
			return nil, ErrTruncated
		}
	default:
		return nil, ErrUnsupported
	}
	return p, nil
}

func (p *IPv4Packet) Src() [4]byte { return [4]byte(p.B[12:16]) }
func (p *IPv4Packet) Dst() [4]byte { return [4]byte(p.B[16:20]) }

func (p *IPv4Packet) SrcPort() uint16 { return binary.BigEndian.Uint16(p.B[p.IHL : p.IHL+2]) }
func (p *IPv4Packet) DstPort() uint16 { return binary.BigEndian.Uint16(p.B[p.IHL+2 : p.IHL+4]) }

// TCPFlags возвращает байт флагов TCP (0 для UDP).
func (p *IPv4Packet) TCPFlags() byte {
	if p.Proto != ProtoTCP {
		return 0
	}
	return p.B[p.IHL+13]
}

const (
	TCPFin byte = 0x01
	TCPSyn byte = 0x02
	TCPRst byte = 0x04
)

func (p *IPv4Packet) SetSrc(a [4]byte) { copy(p.B[12:16], a[:]) }
func (p *IPv4Packet) SetDst(a [4]byte) { copy(p.B[16:20], a[:]) }

func sum16(b []byte, init uint32) uint32 {
	s := init
	for len(b) >= 2 {
		s += uint32(b[0])<<8 | uint32(b[1])
		b = b[2:]
	}
	if len(b) == 1 {
		s += uint32(b[0]) << 8
	}
	return s
}

func fold(s uint32) uint16 {
	for s>>16 != 0 {
		s = (s & 0xffff) + (s >> 16)
	}
	return ^uint16(s)
}

// FixChecksums пересчитывает контрольные суммы IP и TCP/UDP полностью (а не инкрементально):
// у исходящих пакетов при разгрузке контрольных сумм значения могут быть неполными.
func (p *IPv4Packet) FixChecksums() {
	// IP-заголовок
	p.B[10], p.B[11] = 0, 0
	binary.BigEndian.PutUint16(p.B[10:12], fold(sum16(p.B[:p.IHL], 0)))

	seg := p.B[p.IHL:p.total]
	var csumOff int
	if p.Proto == ProtoTCP {
		csumOff = 16
	} else {
		csumOff = 6
	}
	seg[csumOff], seg[csumOff+1] = 0, 0
	var pseudo uint32
	pseudo = sum16(p.B[12:20], 0)
	pseudo += uint32(p.Proto)
	pseudo += uint32(len(seg))
	c := fold(sum16(seg, pseudo))
	if p.Proto == ProtoUDP && c == 0 {
		c = 0xffff
	}
	binary.BigEndian.PutUint16(seg[csumOff:csumOff+2], c)
}

// VerifyChecksums используется в тестах.
func (p *IPv4Packet) VerifyChecksums() bool {
	if fold(sum16(p.B[:p.IHL], 0)) != 0 {
		return false
	}
	seg := p.B[p.IHL:p.total]
	pseudo := sum16(p.B[12:20], 0) + uint32(p.Proto) + uint32(len(seg))
	return fold(sum16(seg, pseudo)) == 0
}
