// Package backend plumbs the desktop shell to a local kap-server: server
// discovery (env → instance registry → legacy lock → default port), the
// persisted bearer token, a one-shot `kimi web --no-open` spawn, and the
// loopback API proxy the webview talks to.
package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultServerURL = "http://127.0.0.1:58627"
	resolveCacheTTL  = 2 * time.Second
	spawnWaitTotal   = 15 * time.Second
	spawnWaitStep    = 250 * time.Millisecond
)

// KimiHomeDir mirrors the CLI's home resolution: KIMI_CODE_HOME, else
// ~/.kimi-code.
func KimiHomeDir() string {
	if fromEnv := os.Getenv("KIMI_CODE_HOME"); fromEnv != "" {
		return fromEnv
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".kimi-code"
	}
	return filepath.Join(home, ".kimi-code")
}

// ReadServerToken returns the persisted bearer token (<home>/server.token),
// or "" when none exists. The web UI prompts for a token on 401, so a missing
// file is not an error.
func ReadServerToken(homeDir string) string {
	raw, err := os.ReadFile(filepath.Join(homeDir, "server.token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

// instanceFile mirrors kap-server's on-disk instance registry entry
// (<home>/server/instances/<serverId>.json, snake_case). The format is
// deliberately reimplemented, matching apps/kimi-inspect/vite/serverDiscovery.ts.
type instanceFile struct {
	ServerID    string `json:"server_id"`
	Pid         int    `json:"pid"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	StartedAt   int64  `json:"started_at"`
	HostVersion string `json:"host_version"`
}

// legacy single-server lock written by pre-registry builds (<home>/server/lock).
type lockFile struct {
	Pid  int    `json:"pid"`
	Host string `json:"host"`
	Port int    `json:"port"`
}

func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	// EPERM means the process exists but is not ours — same semantics as the
	// server's own registry probe: only ESRCH counts as dead.
	return !errors.Is(err, syscall.ESRCH)
}

func normalizeHost(host string) string {
	switch host {
	case "", "0.0.0.0", "::", "[::]":
		return "127.0.0.1"
	}
	return host
}

func readJSONFile[T any](path string) (T, bool) {
	var out T
	raw, err := os.ReadFile(path)
	if err != nil {
		return out, false
	}
	if json.Unmarshal(raw, &out) != nil {
		return out, false
	}
	return out, true
}

// liveInstanceURL returns the longest-running live instance from the registry.
func liveInstanceURL(homeDir string) (*url.URL, bool) {
	instancesDir := filepath.Join(homeDir, "server", "instances")
	entries, err := os.ReadDir(instancesDir)
	if err != nil {
		return nil, false
	}
	type candidate struct {
		startedAt int64
		u         *url.URL
	}
	var live []candidate
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		disk, ok := readJSONFile[instanceFile](filepath.Join(instancesDir, entry.Name()))
		if !ok || disk.ServerID == "" || disk.Port <= 0 || !pidAlive(disk.Pid) {
			continue
		}
		u, err := url.Parse(fmt.Sprintf("http://%s:%d", normalizeHost(disk.Host), disk.Port))
		if err != nil {
			continue
		}
		live = append(live, candidate{startedAt: disk.StartedAt, u: u})
	}
	if len(live) == 0 {
		return nil, false
	}
	sort.Slice(live, func(i, j int) bool { return live[i].startedAt < live[j].startedAt })
	return live[0].u, true
}

func legacyLockURL(homeDir string) (*url.URL, bool) {
	disk, ok := readJSONFile[lockFile](filepath.Join(homeDir, "server", "lock"))
	if !ok || disk.Port <= 0 || !pidAlive(disk.Pid) {
		return nil, false
	}
	u, err := url.Parse(fmt.Sprintf("http://%s:%d", normalizeHost(disk.Host), disk.Port))
	if err != nil {
		return nil, false
	}
	return u, true
}

func tcpReachable(u *url.URL, timeout time.Duration) bool {
	conn, err := net.DialTimeout("tcp", u.Host, timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// Resolver finds the kap-server the proxy should target. Resolution is cheap
// and re-runs (with a small cache) on every proxied request, so a server
// started after the app opened is picked up without a restart.
type Resolver struct {
	homeDir string

	mu        sync.Mutex
	cached    *url.URL
	checkedAt time.Time

	spawnOnce sync.Once
	spawned   *exec.Cmd
}

func NewResolver() *Resolver {
	return &Resolver{homeDir: KimiHomeDir()}
}

func (r *Resolver) HomeDir() string { return r.homeDir }

// Resolve returns the current server base URL. Order: KIMI_SERVER_URL env,
// live instance registry, legacy lock, reachable default port. When nothing
// is found it spawns `kimi web --no-open` once per app run and waits for the
// registry to pick it up.
func (r *Resolver) Resolve(ctx context.Context) (*url.URL, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cached != nil && time.Since(r.checkedAt) < resolveCacheTTL {
		return r.cached, nil
	}
	if u, ok := r.locateLocked(); ok {
		r.cached, r.checkedAt = u, time.Now()
		return u, nil
	}

	r.spawnOnce.Do(r.spawnKimiWebLocked)
	if r.spawned != nil {
		deadline := time.Now().Add(spawnWaitTotal)
		for time.Now().Before(deadline) {
			if u, ok := r.locateLocked(); ok {
				r.cached, r.checkedAt = u, time.Now()
				return u, nil
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(spawnWaitStep):
			}
		}
	}
	return nil, errors.New("no running kimi server found — start one with `kimi web`")
}

func (r *Resolver) locateLocked() (*url.URL, bool) {
	if fromEnv := os.Getenv("KIMI_SERVER_URL"); fromEnv != "" {
		if u, err := url.Parse(fromEnv); err == nil && u.Host != "" {
			return u, true
		}
	}
	if u, ok := liveInstanceURL(r.homeDir); ok {
		return u, true
	}
	if u, ok := legacyLockURL(r.homeDir); ok {
		return u, true
	}
	if u, err := url.Parse(defaultServerURL); err == nil && tcpReachable(u, 300*time.Millisecond) {
		return u, true
	}
	return nil, false
}

// spawnKimiWebLocked starts `kimi web --no-open` when the CLI is on PATH.
// The child is kept attached so StopSpawned can shut it down with the app;
// a server the user started themselves is never touched.
func (r *Resolver) spawnKimiWebLocked() {
	kimi, err := exec.LookPath("kimi")
	if err != nil {
		return
	}
	cmd := exec.Command(kimi, "web", "--no-open")
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return
	}
	r.spawned = cmd
	go func() { _ = cmd.Wait() }()
}

// StopSpawned terminates the `kimi web` child this app started, if any.
func (r *Resolver) StopSpawned() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.spawned == nil || r.spawned.Process == nil {
		return
	}
	_ = r.spawned.Process.Signal(syscall.SIGTERM)
	r.spawned = nil
}
