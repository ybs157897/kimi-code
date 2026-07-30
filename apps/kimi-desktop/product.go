// Phase 1 product forwarding (frozen contract F). The desktop speaks the
// kimi-web product wire directly: ProductCall forwards a desktopProduct method
// to the sidecar's product facade and returns the kimi-web response wire JSON,
// and ProductSubscribe subscribes the session/agent product stream and
// re-emits each projected kimi-web WireEvent on the shared "kimi:event"
// channel. The Go side stays a thin json.RawMessage passthrough — it owns no
// product typing; the wire shapes are owned by
// apps/kimi-web/src/api/daemon/wire.ts and reproduced by the sidecar (frozen
// contract E).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"kimi-desktop/internal/ipcclient"
)

const (
	// productService is the reserved sidecar service that serves the kimi-web
	// product wire (frozen contract E). The sidecar intercepts this name and
	// routes it to the product facade instead of the engine dispatcher; the
	// facade fulfils methods internally, so the call uses the core scope.
	productService = "desktopProduct"
	// productEventStream is the listen stream name for the projected product
	// event feed (frozen contract E). Each pushed event's data is one kimi-web
	// WireEvent (matching apps/kimi-web/src/api/daemon/wire.ts).
	productEventStream = "product"
	// productSubKeyPrefix namespaces product subscriptions in App.subs so they
	// coexist with the Phase 0 agent-event subscriptions for the same
	// session/agent (keyed without a prefix by subscribe in app.go) without
	// colliding. Both kinds are cancelled together on shutdown.
	productSubKeyPrefix = "product:"
)

// ProductCall forwards a desktopProduct method to the sidecar's product facade
// and returns the raw kimi-web response wire JSON (frozen contract F). argsJSON
// is the positional argument list as a JSON array, or a single JSON object that
// is wrapped into a one-element positional array; an empty string means no
// arguments. The call uses the same timeout and error handling as the Phase 0
// bound methods.
func (a *App) ProductCall(method, argsJSON string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	arg, err := parseProductArgs(argsJSON)
	if err != nil {
		return "", err
	}
	ctx, cancel := a.callCtx()
	defer cancel()
	raw, err := client.Call(ctx, ipcclient.Scope{}, productService, method, arg)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// ProductSubscribe subscribes the session/agent product stream and re-emits
// each projected kimi-web WireEvent on the "kimi:event" channel as
// { sessionId, agentId, event: <WireEvent> } (frozen contract F). It reuses the
// Phase 0 subscription bookkeeping (App.subs, cancelled on shutdown) under a
// namespaced key so it coexists with the Phase 0 agent-event subscription for
// the same session/agent without leaking or double-forwarding: re-subscribing
// an already-active product stream is a no-op.
func (a *App) ProductSubscribe(sessionId, agentId string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	return a.subscribeProduct(client, sessionId, agentId)
}

// subscribeProduct mirrors subscribe in app.go for the product stream. It is
// kept separate so the Phase 0 agent-event path stays untouched; the two share
// App.subs and App.emit and must be kept consistent. Unlike subscribe it
// returns the listen error so ProductSubscribe can report a failed setup.
func (a *App) subscribeProduct(client *ipcclient.Client, sessionId, agentId string) error {
	key := productSubKeyPrefix + sessionId + "/" + agentId

	a.mu.Lock()
	if _, ok := a.subs[key]; ok {
		a.mu.Unlock()
		return nil
	}
	a.mu.Unlock()

	subCtx, cancel := context.WithCancel(context.Background())
	ch, err := client.Listen(subCtx,
		ipcclient.Scope{SessionID: sessionId, AgentID: agentId},
		productEventStream,
	)
	if err != nil {
		cancel()
		log.Printf("kimi-desktop: product listen failed for %s: %v", key, err)
		return err
	}

	a.mu.Lock()
	if _, ok := a.subs[key]; ok {
		// Lost a race to a concurrent ProductSubscribe; drop this one.
		a.mu.Unlock()
		cancel()
		return nil
	}
	a.subs[key] = cancel
	a.mu.Unlock()

	go func() {
		defer cancel()
		for ev := range ch {
			// ev.Data is already a kimi-web WireEvent JSON; pass it through.
			a.emit(sessionId, agentId, ev.Data)
		}
	}()
	return nil
}

// parseProductArgs parses a ProductCall argument payload into the positional
// array the klient-ipc call frame carries. A JSON array is used as-is; a JSON
// object is wrapped as a single-element positional array; empty or blank input
// means no arguments. Anything else is rejected so a malformed payload fails
// fast instead of crossing the wire as an unexpected shape.
func parseProductArgs(argsJSON string) ([]any, error) {
	trimmed := strings.TrimSpace(argsJSON)
	if trimmed == "" {
		return nil, nil
	}
	switch trimmed[0] {
	case '[':
		var arr []any
		if err := json.Unmarshal([]byte(trimmed), &arr); err != nil {
			return nil, fmt.Errorf("product args: %w", err)
		}
		return arr, nil
	case '{':
		var obj map[string]any
		if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
			return nil, fmt.Errorf("product args: %w", err)
		}
		return []any{obj}, nil
	default:
		return nil, fmt.Errorf("product args: expected a JSON array or object, got %q", trimmed[0])
	}
}
