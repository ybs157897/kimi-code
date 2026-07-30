// Package sidecar owns the desktop engine helper process.
//
// Development builds launch the repository's TypeScript entry through pnpm.
// Packaged builds embed a Node SEA executable in the Wails binary, extract it
// beneath ~/.kimi-desktop, and launch it directly. The child is configured as
// a background process on Windows so starting the desktop app never creates a
// console window.
package sidecar

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"kimi-desktop/internal/appdata"
)

const (
	// DefaultCommand is used only by development builds, where the embedded
	// runtime is intentionally omitted.
	DefaultCommand = "pnpm --filter @moonshot-ai/kimi-desktop run sidecar"

	readyMarker = "desktop-sidecar ready"

	envEndpoint    = "KIMI_DESKTOP_IPC_ENDPOINT"
	envToken       = "KIMI_DESKTOP_IPC_TOKEN"
	envDesktopHome = "KIMI_DESKTOP_HOME"
	envEngineHome  = "KIMI_CODE_HOME"

	defaultEndpoint = "tcp://127.0.0.1:0"
	readyTimeout    = 30 * time.Second
)

// Sidecar manages one engine helper child process.
type Sidecar struct {
	// Command and Dir are development-only overrides. Packaged builds always
	// launch the embedded executable directly.
	Command string
	Dir     string

	homeDir  string
	endpoint string
	token    string

	mu      sync.Mutex
	cmd     *exec.Cmd
	exited  <-chan error
	started bool
}

// New creates a sidecar rooted exclusively in the desktop application home.
// KIMI_CODE_HOME is deliberately ignored by appdata.HomeDir.
func New() *Sidecar {
	return &Sidecar{
		Command:  DefaultCommand,
		homeDir:  appdata.HomeDir(),
		endpoint: defaultEndpoint,
		token:    newToken(),
	}
}

// Endpoint returns the authenticated local IPC endpoint. Before Start it is
// the requested ephemeral endpoint; after readiness it contains the actual
// loopback port selected by the operating system.
func (s *Sidecar) Endpoint() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.endpoint
}

// Token returns the shared secret presented in the IPC hello handshake.
func (s *Sidecar) Token() string { return s.token }

// Start launches the helper and waits until the engine reports its actual
// listening endpoint.
func (s *Sidecar) Start(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return nil
	}

	if err := os.MkdirAll(s.homeDir, 0o700); err != nil {
		return fmt.Errorf("sidecar: create desktop home: %w", err)
	}

	cmd, label, err := s.command()
	if err != nil {
		return err
	}
	configureChildProcess(cmd)
	cmd.Env = withEnv(os.Environ(), map[string]string{
		envEndpoint:    defaultEndpoint,
		envToken:       s.token,
		envDesktopHome: s.homeDir,
		// Some engine internals still resolve this legacy variable. Override it
		// only inside the helper so all state remains in ~/.kimi-desktop.
		envEngineHome: s.homeDir,
	})

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("sidecar: stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("sidecar: stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("sidecar: spawn %q: %w", label, err)
	}

	ready := make(chan string, 1)
	var readyOnce sync.Once
	scan := func(r io.Reader) {
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Fprintln(os.Stderr, "[sidecar] "+line)
			if index := strings.Index(line, readyMarker); index >= 0 {
				endpoint := strings.TrimSpace(line[index+len(readyMarker):])
				readyOnce.Do(func() { ready <- endpoint })
			}
		}
	}
	go scan(stdout)
	go scan(stderr)

	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	timer := time.NewTimer(readyTimeout)
	defer timer.Stop()
	select {
	case endpoint := <-ready:
		if !strings.HasPrefix(endpoint, "tcp://127.0.0.1:") {
			terminateChildProcess(cmd)
			return fmt.Errorf("sidecar: invalid readiness endpoint %q", endpoint)
		}
		s.endpoint = endpoint
		s.cmd = cmd
		s.exited = exited
		s.started = true
		return nil
	case err := <-exited:
		return fmt.Errorf("sidecar: exited before ready: %v", err)
	case <-timer.C:
		terminateChildProcess(cmd)
		return errors.New("sidecar: timed out waiting for readiness")
	case <-ctx.Done():
		terminateChildProcess(cmd)
		return ctx.Err()
	}
}

// Stop terminates the helper child this application started.
func (s *Sidecar) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd == nil {
		return
	}
	terminateChildProcess(s.cmd)
	if s.exited != nil {
		select {
		case <-s.exited:
		case <-time.After(5 * time.Second):
			if s.cmd.Process != nil {
				_ = s.cmd.Process.Kill()
			}
		}
	}
	s.cmd = nil
	s.exited = nil
	s.started = false
}

func (s *Sidecar) command() (*exec.Cmd, string, error) {
	if payload, name := embeddedRuntime(); len(payload) > 0 {
		path, err := s.extractRuntime(payload, name)
		if err != nil {
			return nil, "", err
		}
		cmd := exec.Command(path)
		cmd.Dir = s.homeDir
		return cmd, path, nil
	}

	parts := strings.Fields(s.Command)
	if len(parts) == 0 {
		return nil, "", errors.New("sidecar: empty development command")
	}
	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Dir = s.dir()
	return cmd, s.Command, nil
}

func (s *Sidecar) extractRuntime(payload []byte, embeddedName string) (string, error) {
	sum := sha256.Sum256(payload)
	version := hex.EncodeToString(sum[:8])
	name := embeddedName
	if name == "" {
		name = "kimi-desktop-engine"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
	}
	dir := filepath.Join(s.homeDir, "runtime", version)
	path := filepath.Join(dir, name)

	if existing, err := os.ReadFile(path); err == nil {
		existingSum := sha256.Sum256(existing)
		if existingSum == sum {
			return path, nil
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("sidecar: create runtime dir: %w", err)
	}
	temp, err := os.CreateTemp(dir, name+".tmp-*")
	if err != nil {
		return "", fmt.Errorf("sidecar: create runtime temp file: %w", err)
	}
	tempPath := temp.Name()
	defer func() { _ = os.Remove(tempPath) }()
	if err := temp.Chmod(0o700); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("sidecar: chmod runtime: %w", err)
	}
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("sidecar: write runtime: %w", err)
	}
	if err := temp.Close(); err != nil {
		return "", fmt.Errorf("sidecar: close runtime: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return "", fmt.Errorf("sidecar: install runtime: %w", err)
	}
	return path, nil
}

func (s *Sidecar) dir() string {
	if s.Dir != "" {
		return s.Dir
	}
	return findRepoRoot()
}

func findRepoRoot() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	for dir := wd; ; {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return wd
		}
		dir = parent
	}
}

func withEnv(base []string, overrides map[string]string) []string {
	result := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		key, _, hasValue := strings.Cut(entry, "=")
		replaced := false
		if hasValue {
			for override := range overrides {
				if strings.EqualFold(key, override) {
					replaced = true
					break
				}
			}
		}
		if replaced {
			continue
		}
		result = append(result, entry)
	}
	for key, value := range overrides {
		result = append(result, key+"="+value)
	}
	return result
}

func newToken() string {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(bytes)
}
