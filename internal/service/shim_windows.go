//go:build windows

package service

import (
	"fmt"
	"os"
)

func RunShim(_, _ string) int {
	fmt.Fprintln(os.Stderr, "ahub node shim is unsupported on windows")
	return 2
}
