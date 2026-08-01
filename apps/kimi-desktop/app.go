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
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"kimi-desktop/internal/appdata"
	"kimi-desktop/internal/ipcclient"
	"kimi-desktop/internal/sidecar"
)

const (
	// eventChannel is the single Wails event name the webview subscribes to
	// (contract C).
	eventChannel = "kimi:event"
	// connectionChannel carries real IPC connection state to the webview so
	// `health()`/`onConnectionChange` reflect socket breaks, not just call
	// failures.
	connectionChannel = "kimi:connection"
	// agentEventStream is the agent-scope event stream name (contract A/B).
	agentEventStream = "events"
	// callTimeout bounds a single klient procedure so a wedged sidecar cannot
	// hang a bound method indefinitely.
	callTimeout = 30 * time.Second
	// startupWaitTimeout lets the first product calls wait for the embedded
	// engine to finish booting instead of racing the background startup.
	startupWaitTimeout = 45 * time.Second
	// dialTimeout bounds one IPC dial attempt during recovery.
	dialTimeout = 15 * time.Second
	// reconnectBackoff bounds the wait between failed recovery attempts.
	reconnectBackoff = 5 * time.Second
)

// ipcClient is the subset of *ipcclient.Client the App consumes, so the
// connection/recovery logic is testable against a fake.
type ipcClient interface {
	Call(ctx context.Context, s ipcclient.Scope, service, method string, arg []any) (json.RawMessage, error)
	Listen(ctx context.Context, s ipcclient.Scope, event string) (<-chan ipcclient.Event, error)
	ListenWithCursor(ctx context.Context, s ipcclient.Scope, event string, arg []any) (<-chan ipcclient.Event, string, error)
	Unlisten(id string) error
	Stream(ctx context.Context, s ipcclient.Scope, service, method string, arg []any) (<-chan ipcclient.StreamEvent, string, error)
	StreamCancel(id string) error
	Close() error
	Done() <-chan struct{}
}

// sidecarProcess is the child-process boundary owned by App. Keeping the
// boundary narrow lets lifecycle tests substitute the external process while
// production continues to use *sidecar.Sidecar.
type sidecarProcess interface {
	Start(ctx context.Context) error
	Stop()
	Endpoint() string
	Token() string
}

type ipcDialer func(ctx context.Context, endpoint, token string) (ipcClient, error)

// App is registered via `Bind: []any{app}` in main.go and surfaced to the
// webview as window.go.main.App.
type App struct {
	sidecar sidecarProcess
	dialIPC ipcDialer

	ctx context.Context

	mu     sync.Mutex
	client ipcClient
	ready  chan struct{}
	// readyOnce closes ready immediately after the first boot attempt, before
	// the long-running connection manager starts.
	readyOnce sync.Once
	// startErr is populated before ready closes when startup fails.
	startErr error
	// shuttingDown guards the recovery loop against the shutdown path.
	shuttingDown atomic.Bool
	// recoveryMu serializes concurrent recovery attempts (the background
	// connection manager and EnsureConnected) so two dials never race.
	recoveryMu sync.Mutex
	// subs cancels the forwarding goroutine for each active Phase 0 agent-event
	// subscription, keyed by "sessionId/agentId".
	subs map[string]context.CancelFunc
	// productSubs tracks each active Phase 1 product-stream subscription (cancel
	// + ipc listen id for Unlisten), keyed by "product:sessionId/agentId".
	productSubs map[string]productSub
	// productStreams tracks each active product download stream (cancel + ipc
	// stream id for StreamCancel), keyed by the web-facing streamId returned
	// from ProductStreamStart.
	productStreams map[string]productStream
	// terminalSubs tracks each active Slice 6 terminal attach subscription
	// (cancel + ipc listen id for Unlisten), keyed by
	// sessionId + "\x00" + terminalId.
	terminalSubs map[string]terminalSub
	// productStreamSeq disambiguates product streamIds generated within the
	// same nanosecond.
	productStreamSeq atomic.Uint64
}

// NewApp constructs the bound App and its sidecar manager.
func NewApp() *App {
	return &App{
		sidecar: sidecar.New(),
		dialIPC: func(ctx context.Context, endpoint, token string) (ipcClient, error) {
			return ipcclient.Dial(ctx, endpoint, token)
		},
		ready:          make(chan struct{}),
		subs:           map[string]context.CancelFunc{},
		productSubs:    map[string]productSub{},
		productStreams: map[string]productStream{},
		terminalSubs:   map[string]terminalSub{},
	}
}

// startup is wired to wails OnStartup. It launches the sidecar and connects
// the IPC client off the window's critical path. Bound product calls wait on
// the ready channel, so the webview cannot race the engine's cold boot.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// Seed the user-level experts root with the bundled defaults. Failure is
	// only logged: it must never block the engine startup, and an existing
	// experts directory is left untouched.
	if err := appdata.MaterializeDefaultExperts(appdata.HomeDir()); err != nil {
		log.Printf("kimi-desktop: materialize default experts: %v", err)
	}
	go a.connect()
}

// connect boots the sidecar + IPC client once, then runs the connection
// manager: it watches for socket breaks, drops every stale subscription, and
// re-dials — restarting the sidecar when the process died — until shutdown.
// The ready channel closes after the first boot attempt (success or failure).
func (a *App) connect() {
	if err := a.boot(); err != nil {
		log.Printf("kimi-desktop: sidecar start failed: %v", err)
		a.mu.Lock()
		a.startErr = err
		a.mu.Unlock()
	}
	// connectionManager normally lives until application shutdown. Signal the
	// first boot result before entering it so a WebView call that raced startup
	// can continue as soon as boot succeeds or fails.
	a.readyOnce.Do(func() { close(a.ready) })
	a.connectionManager()
}

// boot starts the sidecar (if not running) and dials its IPC endpoint once.
func (a *App) boot() error {
	if err := a.sidecar.Start(a.ctx); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(a.ctx, dialTimeout)
	defer cancel()
	client, err := a.dialIPC(ctx, a.sidecar.Endpoint(), a.sidecar.Token())
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.client = client
	a.startErr = nil
	a.mu.Unlock()
	return nil
}

// connectionManager owns the single recovery path. It blocks on the current
// client's Done channel; when the IPC socket breaks (not during shutdown) it
// cleans up every subscription bound to the dead client, reports the
// disconnect to the webview, and re-dials with backoff — healing boot failures
// too, since a nil client just enters the recovery loop.
func (a *App) connectionManager() {
	backoff := time.Second
	for {
		client := a.currentClient()
		if client == nil {
			if a.shuttingDown.Load() {
				return
			}
			if err := a.recover(); err == nil {
				backoff = time.Second
				a.emitConnectionState("connected")
				continue
			} else {
				log.Printf("kimi-desktop: ipc recovery failed: %v", err)
			}
			if a.shuttingDown.Load() {
				return
			}
			select {
			case <-time.After(backoff):
			case <-a.ctx.Done():
				return
			}
			if backoff < reconnectBackoff {
				backoff *= 2
			}
			continue
		}
		select {
		case <-client.Done():
		case <-a.ctx.Done():
			return
		}
		if a.shuttingDown.Load() {
			return
		}
		a.handleDisconnect(client)
	}
}

// handleDisconnect drops every subscription and stream the dead client owned
// (so a later ProductSubscribe is a real re-subscribe, never a stale
// "already exists" no-op), clears the client, and tells the webview.
func (a *App) handleDisconnect(client ipcClient) {
	a.mu.Lock()
	if a.client != client {
		// A newer client already took over (EnsureConnected raced us).
		a.mu.Unlock()
		return
	}
	a.clearSubscriptionsLocked()
	a.client = nil
	a.mu.Unlock()
	_ = client.Close() // idempotent; guarantees the socket is down
	log.Printf("kimi-desktop: ipc disconnected — recovering")
	a.emitConnectionState("disconnected")
}

// recover re-establishes the IPC connection. It first tries a plain re-dial
// against the running sidecar (the common socket-break case); when that fails
// the sidecar process is presumed dead and is restarted under control before
// dialing again. Serialized by recoveryMu so the background manager and
// EnsureConnected never race. A nil error means a live client was installed;
// every failed restart or dial remains an error and must never be reported as
// "connected" to the WebView.
func (a *App) recover() error {
	a.recoveryMu.Lock()
	defer a.recoveryMu.Unlock()
	if a.shuttingDown.Load() {
		return errors.New("desktop application is shutting down")
	}
	if a.currentLiveClient() != nil {
		return nil
	}
	if client, err := a.dial(); err == nil {
		a.installClient(client)
		return nil
	}
	// Dial failed — the sidecar process is likely gone. Restart it and retry.
	a.sidecar.Stop()
	if err := a.sidecar.Start(a.ctx); err != nil {
		return fmt.Errorf("sidecar restart: %w", err)
	}
	if client, err := a.dial(); err == nil {
		a.installClient(client)
		return nil
	} else {
		return fmt.Errorf("ipc dial after sidecar restart: %w", err)
	}
}

func (a *App) dial() (ipcClient, error) {
	ctx, cancel := context.WithTimeout(a.ctx, dialTimeout)
	defer cancel()
	return a.dialIPC(ctx, a.sidecar.Endpoint(), a.sidecar.Token())
}

func (a *App) installClient(client ipcClient) {
	a.mu.Lock()
	a.client = client
	a.startErr = nil
	a.mu.Unlock()
}

func (a *App) emitConnectionState(state string) {
	runtime.EventsEmit(a.ctx, connectionChannel, map[string]any{"state": state})
}

// clearSubscriptionsLocked cancels every active subscription/stream. Callers
// hold a.mu. Shared by handleDisconnect and shutdown.
func (a *App) clearSubscriptionsLocked() {
	for _, cancel := range a.subs {
		cancel()
	}
	a.subs = map[string]context.CancelFunc{}
	for _, sub := range a.productSubs {
		sub.cancel()
	}
	a.productSubs = map[string]productSub{}
	// Cancelling stops the stream forwarding goroutines; the host side aborts
	// them when the socket closes.
	for _, stream := range a.productStreams {
		stream.cancel()
	}
	a.productStreams = map[string]productStream{}
	for _, sub := range a.terminalSubs {
		sub.cancel()
	}
	a.terminalSubs = map[string]terminalSub{}
}

// shutdown is wired to wails OnShutdown: drop subscriptions, close the client,
// then SIGTERM the sidecar. Unexported so Wails does not bind it.
func (a *App) shutdown(_ context.Context) {
	a.shuttingDown.Store(true)
	a.mu.Lock()
	a.clearSubscriptionsLocked()
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
// can render a disconnected state. A client whose socket already broke (Done
// fired) reports disconnected too, not a misleading "error".
func (a *App) Hello() (string, error) {
	status := map[string]any{}
	status["sidecar"] = "down"
	status["ipc"] = "disconnected"
	client := a.currentClient()
	if client == nil {
		return marshal(status), nil
	}
	select {
	case <-client.Done():
		return marshal(status), nil
	default:
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

// EnsureConnected reports the IPC state as JSON `{state: "connected" |
// "disconnected"}`, forcing a bounded synchronous recovery when the connection
// is currently broken. The webview's reconnect() calls this first so a
// resubscribe never targets a dead client.
func (a *App) EnsureConnected() (string, error) {
	if a.currentLiveClient() != nil {
		return marshal(map[string]string{"state": "connected"}), nil
	}
	if a.shuttingDown.Load() {
		return marshal(map[string]string{"state": "disconnected"}), nil
	}
	if err := a.recover(); err != nil {
		log.Printf("kimi-desktop: synchronous ipc recovery failed: %v", err)
		return marshal(map[string]string{"state": "disconnected"}), nil
	}
	a.emitConnectionState("connected")
	return marshal(map[string]string{"state": "connected"}), nil
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

func (a *App) currentClient() ipcClient {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.client
}

func (a *App) currentLiveClient() ipcClient {
	client := a.currentClient()
	if client == nil {
		return nil
	}
	select {
	case <-client.Done():
		return nil
	default:
		return client
	}
}

func (a *App) requireClient() (ipcClient, error) {
	if c := a.currentLiveClient(); c != nil {
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
		select {
		case <-a.client.Done():
			return nil, errors.New("desktop engine IPC not connected")
		default:
		}
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
