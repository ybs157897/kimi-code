//go:build !windows

package sidecar

import (
	"os/exec"
	"syscall"
)

func configureChildProcess(_ *exec.Cmd) {}

func terminateChildProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
}
