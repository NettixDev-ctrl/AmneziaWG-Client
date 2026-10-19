package main

import (
	"fmt"
	"net/netip"
	"strings"
)

// Имена таблиц nftables, которыми владеет служба.
const (
	ksTable     = "privata_ks"
	tunnelIface = "privata0"
	// SplitMark — метка пакетов, идущих мимо VPN (используется и раздельным туннелированием).
	SplitMark = 0x5052
	// awgMark — fwmark, который awg-quick ставит на собственные пакеты туннеля (51820).
	awgMark = 0xca6c
)

// KSParams — параметры правил kill switch.
type KSParams struct {
	Endpoint netip.Addr // адрес сервера
	Port     int
	AllowLAN bool
	// AllowSplitMark разрешает пакеты, помеченные раздельным туннелированием (идут мимо VPN по выбору пользователя).
	AllowSplitMark bool
}

// KillSwitchRuleset возвращает набор правил nftables: всё, что не идёт через туннель, блокируется.
// Исключения: loopback, пакеты самого туннеля к серверу, DHCP, (по желанию) локальная сеть.
func KillSwitchRuleset(p KSParams) string {
	var b strings.Builder
	fmt.Fprintf(&b, "table inet %s {\n  chain out {\n    type filter hook output priority 0; policy accept;\n", ksTable)
	b.WriteString("    oifname \"lo\" accept\n")
	fmt.Fprintf(&b, "    oifname \"%s\" accept\n", tunnelIface)
	fmt.Fprintf(&b, "    meta mark 0x%x accept\n", awgMark)
	if p.Endpoint.IsValid() {
		fam := "ip"
		if p.Endpoint.Is6() {
			fam = "ip6"
		}
		fmt.Fprintf(&b, "    %s daddr %s udp dport %d accept\n", fam, p.Endpoint, p.Port)
	}
	b.WriteString("    udp sport 68 udp dport 67 accept\n")
	b.WriteString("    meta nfproto ipv6 udp sport 546 udp dport 547 accept\n")
	b.WriteString("    meta l4proto ipv6-icmp icmpv6 type { nd-router-solicit, nd-neighbor-solicit, nd-neighbor-advert } accept\n")
	if p.AllowLAN {
		b.WriteString("    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 224.0.0.0/4 } accept\n")
		b.WriteString("    ip6 daddr { fe80::/10, fc00::/7, ff00::/8 } accept\n")
	}
	if p.AllowSplitMark {
		fmt.Fprintf(&b, "    meta mark 0x%x accept\n", SplitMark)
	}
	b.WriteString("    drop\n  }\n}\n")
	return b.String()
}

const tuneTable = "privata_tune"

// TuneRuleset — подстройка трафика в туннеле:
//   - подгонка MSS под MTU туннеля: без неё TLS-рукопожатия с большими пакетами зависают, если ICMP «fragmentation needed» не доходит;
//   - немедленный отказ для IPv6 в туннеле (сервер IPv6 не отдаёт): приложения сразу переходят на IPv4 вместо ожидания таймаута.
func TuneRuleset(blockIPv6 bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "add table inet %s\ndelete table inet %s\n", tuneTable, tuneTable)
	fmt.Fprintf(&b, "table inet %s {\n  chain tune_out {\n    type filter hook output priority mangle; policy accept;\n", tuneTable)
	fmt.Fprintf(&b, "    oifname \"%s\" tcp flags syn tcp option maxseg size set rt mtu\n", tunnelIface)
	if blockIPv6 {
		fmt.Fprintf(&b, "    oifname \"%s\" meta nfproto ipv6 reject with icmpv6 type no-route\n", tunnelIface)
	}
	b.WriteString("  }\n  chain tune_fw {\n    type filter hook forward priority mangle; policy accept;\n")
	fmt.Fprintf(&b, "    oifname \"%s\" tcp flags syn tcp option maxseg size set rt mtu\n  }\n}\n", tunnelIface)
	return b.String()
}
