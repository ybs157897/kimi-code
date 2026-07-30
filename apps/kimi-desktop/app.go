// The Wails-bound App object (frozen contract C). It is a thin facade over the
// M2 ipcclient: bind methods forward to klient procedures and return raw JSON
// strings for the webview to parse, and agent events received over the IPC
// subscription are re-emitted on the "kimi:event" channel. It owns no protocol
// details — framing and correlation live in internal/ipcclient.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"kimi-desktop/internal/ipcclient"
	"kimi-desktop/internal/sidecar"
)

const (
	// eventChannel is the single Wails event name the webview subscribes to
	// (contract C).
	eventChannel = "kimi:event"
	// agentEventStream is the agent-scope event stream name (contract A/B).
	agentEventStream = "events"
	// callTimeout bounds a single klient procedure so a wedged sidecar cannot
	// hang a bound method indefinitely.
	callTimeout = 30 * time.Second
	// startupWaitTimeout lets the first product calls wait for the embedded
	// engine to finish booting instead of racing the background startup.
	startupWaitTimeout = 45 * time.Second
)

// App is registered via `Bind: []any{app}` in main.go and surfaced to the
// webview as window.go.main.App.
type App struct {
	sidecar *sidecar.Sidecar

	ctx context.Context

	mu     sync.Mutex
	client *ipcclient.Client
	ready  chan struct{}
	// startErr is populated before ready closes when startup fails.
	startErr error
	// subs cancels the forwarding goroutine for each active Phase 0 agent-event
	// subscription, keyed by "sessionId/agentId".
	subs map[string]context.CancelFunc
	// productSubs tracks each active Phase 1 product-stream subscription (cancel
	// + ipc listen id for Unlisten), keyed by "product:sessionId/agentId".
	productSubs map[string]productSub
}

// NewApp constructs the bound App and its sidecar manager.
func NewApp() *App {
	return &App{
		sidecar:     sidecar.New(),
		ready:       make(chan struct{}),
		subs:        map[string]context.CancelFunc{},
		productSubs: map[string]productSub{},
	}
}

// startup is wired to wails OnStartup. It launches the sidecar and connects
// the IPC client off the window's critical path. Bound product calls wait on
// the ready channel, so the webview cannot race the engine's cold boot.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go a.connect()
}

func (a *App) connect() {
	defer close(a.ready)
	if err := a.sidecar.Start(a.ctx); err != nil {
		log.Printf("kimi-desktop: sidecar start failed: %v", err)
		a.mu.Lock()
		a.startErr = err
		a.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := ipcclient.Dial(ctx, a.sidecar.Endpoint(), a.sidecar.Token())
	if err != nil {
		log.Printf("kimi-desktop: ipc dial failed: %v", err)
		a.mu.Lock()
		a.startErr = err
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	a.client = client
	a.mu.Unlock()
}

// shutdown is wired to wails OnShutdown: drop subscriptions, close the client,
// then SIGTERM the sidecar. Unexported so Wails does not bind it.
func (a *App) shutdown(_ context.Context) {
	a.mu.Lock()
	for _, cancel := range a.subs {
		cancel()
	}
	a.subs = map[string]context.CancelFunc{}
	for _, sub := range a.productSubs {
		sub.cancel()
	}
	a.productSubs = map[string]productSub{}
	client := a.client
	a.client = nil
	a.mu.Unlock()

	if client != nil {
		_ = client.Close()
	}
	a.sidecar.Stop()
}

// ── bound surface (contract C) ──────────────────────────────────────────────

// Hello reports sidecar/IPC health as a JSON object. It probes the engine with
// a cheap bootstrap read; a missing client is reported, not thrown, so the UI
// can render a disconnected state.
func (a *App) Hello() (string, error) {
	status := map[string]any{}
	status["sidecar"] = "down"
	status["ipc"] = "disconnected"
	client := a.currentClient()
	if client == nil {
		return marshal(status), nil
	}
	ctx, cancel := a.callCtx()
	defer cancel()
	raw, err := client.Call(ctx, ipcclient.Scope{}, "bootstrapService", "platform", nil)
	if err != nil {
		status["sidecar"] = "error"
		status["error"] = err.Error()
		return marshal(status), nil
	}
	status["sidecar"] = "ok"
	status["ipc"] = "connected"
	status["platform"] = json.RawMessage(raw)
	return marshal(status), nil
}

// ListSessions returns the klient global session index page (sessionIndex.list).
func (a *App) ListSessions() (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	ctx, cancel := a.callCtx()
	defer cancel()
	raw, err := client.Call(ctx, ipcclient.Scope{}, "sessionIndex", "list", []any{map[string]any{}})
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// CreateSession creates a session rooted at the shell's working directory
// (sessionLifecycleService.create) and returns its metadata
// (sessionMetadata.read), mirroring klient's global.sessions.create.
func (a *App) CreateSession() (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	ctx, cancel := a.callCtx()
	defer cancel()

	workDir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	raw, err := client.Call(ctx, ipcclient.Scope{}, "sessionLifecycleService", "create", []any{
		map[string]any{"workDir": workDir},
	})
	if err != nil {
		return "", err
	}
	var handle struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &handle); err != nil || handle.ID == "" {
		// Unexpected handle shape — hand the raw result back rather than fail.
		return string(raw), nil
	}
	meta, err := client.Call(ctx, ipcclient.Scope{SessionID: handle.ID}, "sessionMetadata", "read", nil)
	if err != nil {
		return string(raw), nil
	}
	return string(meta), nil
}

// Submit drives a turn: it (lazily) subscribes to the agent's event stream,
// then sends the prompt (agentRPCService.prompt) with a single text part.
func (a *App) Submit(sessionId, agentId, text string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	a.subscribe(sessionId, agentId)

	ctx, cancel := a.callCtx()
	defer cancel()
	input := []any{map[string]any{"type": "text", "text": text}}
	_, err = client.Call(ctx,
		ipcclient.Scope{SessionID: sessionId, AgentID: agentId},
		"agentRPCService", "prompt",
		[]any{map[string]any{"input": input}},
	)
	return err
}

// Cancel aborts the in-flight turn (agentRPCService.cancel).
func (a *App) Cancel(sessionId, agentId string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	ctx, cancel := a.callCtx()
	defer cancel()
	_, err = client.Call(ctx,
		ipcclient.Scope{SessionID: sessionId, AgentID: agentId},
		"agentRPCService", "cancel",
		[]any{map[string]any{}},
	)
	return err
}

// ── events ──────────────────────────────────────────────────────────────────

// subscribe starts forwarding the agent's event stream to the "kimi:event"
// channel if not already subscribed for this session/agent. Re-subscribing on
// Submit is acceptable for Phase 0; existing subscriptions are reused.
func (a *App) subscribe(sessionId, agentId string) {
	key := sessionId + "/" + agentId

	a.mu.Lock()
	if _, ok := a.subs[key]; ok {
		a.mu.Unlock()
		return
	}
	client := a.client
	a.mu.Unlock()
	if client == nil {
		return
	}

	subCtx, cancel := context.WithCancel(context.Background())
	ch, err := client.Listen(subCtx,
		ipcclient.Scope{SessionID: sessionId, AgentID: agentId},
		agentEventStream,
	)
	if err != nil {
		cancel()
		log.Printf("kimi-desktop: listen failed for %s: %v", key, err)
		return
	}

	a.mu.Lock()
	if _, ok := a.subs[key]; ok {
		// Lost a race to another Submit; drop this subscription.
		a.mu.Unlock()
		cancel()
		return
	}
	a.subs[key] = cancel
	a.mu.Unlock()

	go func() {
		defer cancel()
		for ev := range ch {
			a.emit(sessionId, agentId, ev.Data)
		}
	}()
}

func (a *App) emit(sessionId, agentId string, data json.RawMessage) {
	var event any
	if err := json.Unmarshal(data, &event); err != nil {
		event = string(data)
	}
	runtime.EventsEmit(a.ctx, eventChannel, map[string]any{
		"sessionId": sessionId,
		"agentId":   agentId,
		"event":     event,
	})
}

// ── helpers ─────────────────────────────────────────────────────────────────

func (a *App) currentClient() *ipcclient.Client {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.client
}

func (a *App) requireClient() (*ipcclient.Client, error) {
	if c := a.currentClient(); c != nil {
		return c, nil
	}

	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, startupWaitTimeout)
	defer cancel()
	select {
	case <-a.ready:
	case <-ctx.Done():
		return nil, fmt.Errorf("desktop engine startup: %w", ctx.Err())
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.client != nil {
		return a.client, nil
	}
	if a.startErr != nil {
		return nil, fmt.Errorf("desktop engine startup: %w", a.startErr)
	}
	return nil, errors.New("desktop engine IPC not connected")
}

func (a *App) callCtx() (context.Context, context.CancelFunc) {
	parent := a.ctx
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, callTimeout)
}

func marshal(v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(raw)
}
