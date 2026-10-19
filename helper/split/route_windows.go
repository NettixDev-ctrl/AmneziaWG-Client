package split

import (
	"errors"
	"fmt"
	"net"

	"golang.org/x/sys/windows"

	"github.com/amnezia-vpn/amneziawg-windows/v3/tunnel/winipcfg"
)

type ifaceInfo struct {
	Index uint32
	IP    [4]byte
}

// tunnelInterface находит адаптер туннеля по имени и его IPv4-адрес.
func tunnelInterface(name string) (ifaceInfo, error) {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		return ifaceInfo{}, fmt.Errorf("адаптер %q не найден: %w", name, err)
	}
	ip, err := firstIPv4(ifc)
	if err != nil {
		return ifaceInfo{}, fmt.Errorf("у адаптера %q нет адреса IPv4: %w", name, err)
	}
	return ifaceInfo{Index: uint32(ifc.Index), IP: ip}, nil
}

func firstIPv4(ifc *net.Interface) ([4]byte, error) {
	addrs, err := ifc.Addrs()
	if err != nil {
		return [4]byte{}, err
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			if v4 := n.IP.To4(); v4 != nil && !v4.IsLinkLocalUnicast() && !v4.IsLoopback() {
				return [4]byte(v4), nil
			}
		}
	}
	return [4]byte{}, errors.New("нет подходящего адреса")
}

// physicalInterface выбирает интерфейс с лучшим маршрутом по умолчанию, кроме туннельного.
func physicalInterface(tunIndex uint32) (ifaceInfo, error) {
	tunLUID, err := winipcfg.LUIDFromIndex(tunIndex)
	if err != nil {
		return ifaceInfo{}, err
	}
	routes, err := winipcfg.GetIPForwardTable2(windows.AF_INET)
	if err != nil {
		return ifaceInfo{}, err
	}
	var best *winipcfg.MibIPforwardRow2
	var bestMetric uint32
	for i := range routes {
		r := &routes[i]
		if r.DestinationPrefix.PrefixLength != 0 || r.InterfaceLUID == tunLUID {
			continue
		}
		ipif, err := r.InterfaceLUID.IPInterface(windows.AF_INET)
		if err != nil {
			continue
		}
		m := r.Metric + ipif.Metric
		if best == nil || m < bestMetric {
			best, bestMetric = r, m
		}
	}
	if best == nil {
		return ifaceInfo{}, errors.New("не найден физический интерфейс с маршрутом по умолчанию")
	}
	ifc, err := net.InterfaceByIndex(int(best.InterfaceIndex))
	if err != nil {
		return ifaceInfo{}, err
	}
	ip, err := firstIPv4(ifc)
	if err != nil {
		return ifaceInfo{}, err
	}
	return ifaceInfo{Index: best.InterfaceIndex, IP: ip}, nil
}
