package split

import "syscall"

func syscallErrno(n int) error { return syscall.Errno(n) }
