package split

import (
	"encoding/binary"
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Минимальная привязка к WinDivert 2.2 (LGPL-3.0/GPL-2.0, https://reqrypt.org/windivert.html).
// DLL загружается по абсолютному пути рядом с исполняемым файлом, а не по имени.

const (
	layerNetwork = 0
	layerSocket  = 3

	flagSniff    = 0x0001
	flagRecvOnly = 0x0004

	shutdownRecv = 0x1

	eventSocketBind    = 3
	eventSocketConnect = 4
	eventSocketClose   = 7

	invalidHandle = ^uintptr(0)
)

// address — WINDIVERT_ADDRESS (80 байт).
type address struct {
	Timestamp int64
	flags     uint32
	reserved2 uint32
	data      [64]byte
}

func (a *address) layer() uint8   { return uint8(a.flags & 0xff) }
func (a *address) event() uint8   { return uint8((a.flags >> 8) & 0xff) }
func (a *address) outbound() bool { return a.flags&(1<<17) != 0 }
func (a *address) setOutbound(v bool) {
	if v {
		a.flags |= 1 << 17
	} else {
		a.flags &^= 1 << 17
	}
}

// Биты 21–23: контрольные суммы IP/TCP/UDP признаны корректными (пересчитывать не нужно).
func (a *address) markChecksumsValid() { a.flags |= 7 << 21 }

func (a *address) ifIdx() uint32 { return binary.LittleEndian.Uint32(a.data[0:4]) }
func (a *address) setIfIdx(idx uint32) {
	binary.LittleEndian.PutUint32(a.data[0:4], idx)
	binary.LittleEndian.PutUint32(a.data[4:8], 0) // SubIfIdx
}

// socketData разбирает WINDIVERT_DATA_SOCKET (адреса не нужны — решение принимается по порту).
func (a *address) socketData() (pid uint32, localPort uint16, proto uint8) {
	pid = binary.LittleEndian.Uint32(a.data[16:20])
	localPort = binary.LittleEndian.Uint16(a.data[52:54])
	proto = a.data[56]
	return
}

type divertLib struct {
	dll                                                   *windows.DLL
	open, recv, send, shutdown, closeH, setParam, compile *windows.Proc
}

func loadDivert(path string) (*divertLib, error) {
	dll, err := windows.LoadDLL(path)
	if err != nil {
		return nil, fmt.Errorf("не удалось загрузить WinDivert.dll: %w", err)
	}
	l := &divertLib{dll: dll}
	for name, dst := range map[string]**windows.Proc{
		"WinDivertOpen": &l.open, "WinDivertRecv": &l.recv, "WinDivertSend": &l.send,
		"WinDivertShutdown": &l.shutdown, "WinDivertClose": &l.closeH, "WinDivertSetParam": &l.setParam,
		"WinDivertHelperCompileFilter": &l.compile,
	} {
		p, err := dll.FindProc(name)
		if err != nil {
			dll.Release()
			return nil, err
		}
		*dst = p
	}
	return l, nil
}

type divertHandle struct {
	lib *divertLib
	h   uintptr
}

var errShutdown = errors.New("handle shut down")

func (l *divertLib) Open(filter string, layer int, priority int16, flags uint64) (*divertHandle, error) {
	f, err := windows.BytePtrFromString(filter)
	if err != nil {
		return nil, err
	}
	h, _, e := l.open.Call(uintptr(unsafe.Pointer(f)), uintptr(layer), uintptr(uint16(priority)), uintptr(flags))
	if h == invalidHandle {
		return nil, fmt.Errorf("WinDivertOpen(%q): %w", filter, e)
	}
	// Увеличенная очередь снижает потери пакетов при всплесках.
	l.setParam.Call(h, 0 /*QUEUE_LENGTH*/, 8192)
	l.setParam.Call(h, 2 /*QUEUE_SIZE*/, 8<<20)
	return &divertHandle{lib: l, h: h}, nil
}

func (d *divertHandle) Recv(buf []byte, addr *address) (int, error) {
	var n uint32
	r, _, e := d.lib.recv.Call(d.h, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(addr)))
	if r == 0 {
		if errno, ok := e.(windows.Errno); ok && (errno == windows.ERROR_NO_DATA || errno == windows.ERROR_OPERATION_ABORTED || errno == windows.ERROR_INVALID_HANDLE) {
			return 0, errShutdown
		}
		return 0, e
	}
	return int(n), nil
}

func (d *divertHandle) Send(pkt []byte, addr *address) error {
	var n uint32
	r, _, e := d.lib.send.Call(d.h, uintptr(unsafe.Pointer(&pkt[0])), uintptr(len(pkt)), uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(addr)))
	if r == 0 {
		return e
	}
	return nil
}

func (d *divertHandle) Shutdown() { d.lib.shutdown.Call(d.h, shutdownRecv) }
func (d *divertHandle) Close()    { d.lib.closeH.Call(d.h) }
