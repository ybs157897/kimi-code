// Package sidecar owns the Node engine-host child process for the desktop
// shell: it generates the IPC token, spawns the sidecar with the socket path
// and token in its environment, waits for the sidecar's readiness line, keeps
// the child attached for the app's lifetime, and SIGTERMs it on shutdown.
//
// It speaks only the spawn contract (docs/plan/desktop-product.md §7); it knows
// nothing about the klient-ipc protocol — that is the ipcclient's job.
package sidecar

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"kimi-desktop/internal/backend"
)

const (
	// DefaultCommand is the dev launch command documented for the sidecar,
	// run from the repository root. It delegates to the package's `sidecar`
	// script, which wraps tsx with the decorator-aware tsconfig and the `?raw`
	// text loader the engine needs — a bare `tsx sidecar/main.ts` does not run
	// from source. It is configurable (Sidecar.Command) so a packaged build can
	// swap in a bundled node entry later.
	DefaultCommand = "pnpm --filter @moonshot-ai/kimi-desktop run sidecar"

	// readyMarker is the stable readiness line the sidecar logs once it is
	// serving the IPC socket (contract D).
	readyMarker = "desktop-sidecar ready"

	envSocket = "KIMI_DESKTOP_IPC_SOCKET"
	envToken  = "KIMI_DESKTOP_IPC_TOKEN"

	readyTimeout = 30 * time.Second
)

// Sidecar manages one engine-host child process.
type Sidecar struct {
	// Command is the launch command, split on whitespace. Defaults to
	// DefaultCommand.
	Command string
	// Dir is the working directory the command runs in. When empty, the
	// repository root is located by walking up from the current directory
	// (the dev command resolves its entrypoint relative to the repo root).
	Dir string

	socket string
	token  string

	mu      sync.Mutex
	cmd     *exec.Cmd
	started bool
}

// New builds a Sidecar bound to <kimiHome>/desktop/sidecar.sock with a fresh
// random token. kimiHome mirrors the CLI (KIMI_CODE_HOME, else ~/.kimi-code).
func New() *Sidecar {
	home := backend.KimiHomeDir()
	return &Sidecar{
		Command: DefaultCommand,
		socket:  filepath.Join(home, "desktop", "sidecar.sock"),
		token:   newToken(),
	}
}

// Socket returns the unix socket path the sidecar serves (and the client dials).
func (s *Sidecar) Socket() string { return s.socket }

// Token returns the shared secret the client presents in the hello handshake.
func (s *Sidecar) Token() string { return s.token }

// Start spawns the sidecar and blocks until it logs its readiness line (or the
// context / timeout fires). The child is kept attached and reaped by a
// background wait so Stop can shut it down with the app.
func (s *Sidecar) Start(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(s.socket), 0o755); err != nil {
		return fmt.Errorf("sidecar: create socket dir: %w", err)
	}

	parts := strings.Fields(s.Command)
	if len(parts) == 0 {
		return errors.New("sidecar: empty launch command")
	}
	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Dir = s.dir()
	cmd.Env = append(os.Environ(),
		envSocket+"="+s.socket,
		envToken+"="+s.token,
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("sidecar: spawn %q: %w", s.Command, err)
	}

	ready := make(chan struct{})
	var readyOnce sync.Once
	signalReady := func() { readyOnce.Do(func() { close(ready) }) }
	scan := func(r io.Reader) {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			fmt.Fprintln(os.Stderr, "[sidecar] "+line)
			if strings.Contains(line, readyMarker) {
				signalReady()
			}
		}
	}
	go scan(stdout)
	go scan(stderr)

	// Reap the child for the app's lifetime; its exit also aborts the wait
	// below when the sidecar dies before becoming ready.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	select {
	case <-ready:
		s.cmd = cmd
		s.started = true
		return nil
	case err := <-exited:
		return fmt.Errorf("sidecar: exited before ready: %v", err)
	case <-time.After(readyTimeout):
		_ = cmd.Process.Signal(syscall.SIGTERM)
		return errors.New("sidecar: timed out waiting for readiness")
	case <-ctx.Done():
		_ = cmd.Process.Signal(syscall.SIGTERM)
		return ctx.Err()
	}
}

// Stop terminates the sidecar child this app started, if any.
func (s *Sidecar) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil || s.cmd.Process == nil {
		return
	}
	_ = s.cmd.Process.Signal(syscall.SIGTERM)
	s.cmd = nil
	s.started = false
}

func (s *Sidecar) dir() string {
	if s.Dir != "" {
		return s.Dir
	}
	return findRepoRoot()
}

// findRepoRoot walks up from the current directory looking for the workspace
// marker, falling back to the current directory when none is found.
func findRepoRoot() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	for d := wd; ; {
		if _, err := os.Stat(filepath.Join(d, "pnpm-workspace.yaml")); err == nil {
			return d
		}
		parent := filepath.Dir(d)
		if parent == d {
			return wd
		}
		d = parent
	}
}

func newToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand reads do not fail in practice; keep a fallback so the
		// shell still boots in a degraded environment.
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
