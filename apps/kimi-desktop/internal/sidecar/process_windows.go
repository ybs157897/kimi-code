//go:build windows

package sidecar

import (
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

func configureChildProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}

func terminateChildProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
