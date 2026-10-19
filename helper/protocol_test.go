package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateRejectsBadRequests(t *testing.T) {
	bad := []Request{
		{Op: "format-c"},
		{Op: OpConnect},
		{Op: OpConnect, Config: strings.Repeat("x", MaxConfigBytes+1)},
		{Op: OpConnect, Config: "x", StaleAfterSec: 5},
		{Op: OpConnect, Config: "x", Split: &SplitRequest{Mode: "evil"}},
		{Op: OpConnect, Config: "x", Split: &SplitRequest{Mode: "bypass", Apps: []string{`cmd.exe /c calc`}}},
		{Op: OpConnect, Config: "x", Split: &SplitRequest{Mode: "include"}},
		{Op: OpLogs, Tail: 99999},
	}
	for i, r := range bad {
		r := r
		if _, err := Validate(&r); err == nil {
			t.Errorf("запрос #%d должен быть отклонён: %+v", i, r.Op)
		}
	}
}

func TestValidateAcceptsAndNormalizes(t *testing.T) {
	r := Request{Op: OpConnect, Config: "[Interface]", Split: &SplitRequest{Mode: "bypass", Apps: []string{`C:\A\a.exe`, `c:\a\A.EXE`, `D:\b.exe`}}}
	v, err := Validate(&r)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.SplitApps) != 2 || v.SplitMode != "bypass" || v.StaleAfterSec != 195 {
		t.Fatalf("неожиданный результат: %+v", v)
	}
	empty := Request{Op: OpConnect, Config: "x", Split: &SplitRequest{Mode: "bypass"}}
	v, _ = Validate(&empty)
	if v.SplitMode != "all" {
		t.Fatal("режим bypass без приложений должен превращаться в all")
	}
}

func TestStatusJSONShape(t *testing.T) {
	b, _ := json.Marshal(Status{State: "running"})
	s := string(b)
	for _, key := range []string{`"state"`, `"handshakeAgeSec":null`, `"rxBytes"`, `"txBytes"`, `"errorCode":null`, `"split"`, `"activeFlows"`} {
		if !strings.Contains(s, key) {
			t.Errorf("в JSON нет %s: %s", key, s)
		}
	}
}
