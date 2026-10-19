package split

import (
	"strings"
	"testing"
)

func TestLinuxRulesetBypass(t *testing.T) {
	r, err := LinuxRuleset(ModeBypass, "privata0")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"delete table ip privata_split", `oifname != "privata0" return`, `socket cgroupv2 level 2 "privata-vpn/apps" meta mark set 0x5052`,
		`meta mark 0x5052 oifname != "privata0" masquerade`, "type route hook output", "meta mark != 0 return",
	} {
		if !strings.Contains(r, want) {
			t.Errorf("нет %q:\n%s", want, r)
		}
	}
	if strings.Contains(r, "return\n    meta mark set") {
		t.Error("в режиме bypass не должно быть безусловной метки")
	}
}

func TestLinuxRulesetInclude(t *testing.T) {
	r, _ := LinuxRuleset(ModeInclude, "privata0")
	i := strings.Index(r, `socket cgroupv2 level 2 "privata-vpn/apps" return`)
	j := strings.Index(r, "meta mark set 0x5052")
	if i < 0 || j < 0 || i > j {
		t.Fatalf("приложения из cgroup должны выходить до установки метки:\n%s", r)
	}
}

func TestLinuxRulesetRejectsBadInput(t *testing.T) {
	if _, err := LinuxRuleset(ModeAll, "privata0"); err == nil {
		t.Error("режим all не требует правил")
	}
	for _, bad := range []string{"", "a b", `a"b`, "a;b", "waytoolonginterfacename"} {
		if _, err := LinuxRuleset(ModeBypass, bad); err == nil {
			t.Errorf("%q должен быть отклонён", bad)
		}
	}
}

func TestParseRouteGet(t *testing.T) {
	r, err := ParseRouteGet([]byte(`[{"dst":"203.0.113.7","gateway":"192.168.1.1","dev":"wlan0","prefsrc":"192.168.1.50"}]`))
	if err != nil || r.Dev != "wlan0" || r.Gateway != "192.168.1.1" {
		t.Fatalf("%v %+v", err, r)
	}
	r, err = ParseRouteGet([]byte(`[{"dst":"10.0.0.1","dev":"ppp0"}]`))
	if err != nil || r.Gateway != "" {
		t.Fatalf("%v %+v", err, r)
	}
	for _, bad := range []string{``, `[]`, `[{"dev":""}]`, `[{"dev":"a;b"}]`, `nonsense`} {
		if _, err := ParseRouteGet([]byte(bad)); err == nil {
			t.Errorf("%q должен быть ошибкой", bad)
		}
	}
}

func TestParseProcStat(t *testing.T) {
	// имя процесса содержит пробелы и скобки
	stat := "1234 (my (weird) app) S 77 1234 1234 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 5 0 987654 1000 100 18446744073709551615"
	ppid, start, err := ParseProcStat(stat)
	if err != nil || ppid != 77 || start != 987654 {
		t.Fatalf("%d %d %v", ppid, start, err)
	}
	for _, bad := range []string{"", "1 (x", "1 (x) S 2"} {
		if _, _, err := ParseProcStat(bad); err == nil {
			t.Errorf("%q должен быть ошибкой", bad)
		}
	}
}

func TestParseCgroupV2(t *testing.T) {
	p, ok := ParseCgroupV2("0::/user.slice/user-1000.slice/app.scope\n")
	if !ok || p != "/user.slice/user-1000.slice/app.scope" {
		t.Fatal(p, ok)
	}
	if _, ok := ParseCgroupV2("12:cpu:/foo\n"); ok {
		t.Error("cgroup v1 не поддерживается")
	}
	if _, ok := ParseCgroupV2("0::/../../etc"); ok {
		t.Error("выход за пределы cgroup недопустим")
	}
}
