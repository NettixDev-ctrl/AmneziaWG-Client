//go:build !windows && !linux

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "awg-helper работает только в Windows (сборка для проверки протокола и тестов).")
	os.Exit(2)
}
