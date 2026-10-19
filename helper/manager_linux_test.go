//go:build linux

package main

import "testing"

func TestLastLinesSkipsCommandEcho(t *testing.T) {
	out := []byte("[#] ip link add privata0 type amneziawg\n[#] amneziawg-go privata0\nERROR: something bad\nRTNETLINK answers: File exists\n")
	got := lastLines(out, 3)
	if got != "ERROR: something bad | RTNETLINK answers: File exists" {
		t.Fatalf("%q", got)
	}
	if len(lastLines([]byte(string(make([]byte, 1000))), 3)) > 240 {
		t.Fatal("вывод должен усекаться")
	}
}

func TestMissingToolsListsOnlyWhatIsMissing(t *testing.T) {
	// на тестовой машине могут быть любые инструменты; проверяем лишь, что функция не паникует и не дублирует
	seen := map[string]bool{}
	for _, m := range missingTools(true) {
		if seen[m] {
			t.Fatalf("дубликат %s", m)
		}
		seen[m] = true
	}
}
