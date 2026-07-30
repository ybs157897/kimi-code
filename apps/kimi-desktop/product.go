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
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

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
	// streamChannel is the Wails event name product download streams are
	// re-emitted on (Slice 5). Each payload is one { streamId, type, ... }
	// object; see emitStreamEvent for the shape.
	streamChannel = "kimi:stream"
	// terminalChannel is the Wails event name terminal frames are re-emitted
	// on (Slice 6), kept separate from the kimi:event chat channel so terminal
	// output never mixes into the product WireEvent stream. Each payload is one
	// { sessionId, terminalId, type, ... } object; see emitTerminalFrame for the
	// shape.
	terminalChannel = "kimi:terminal"
	// terminalEventStream is the listen stream name for the session terminal
	// feed (Slice 6). The sidecar host intercepts this name and attaches the
	// session terminal service sink; each pushed event's data is one engine
	// TerminalFrame (terminal_output / terminal_exit).
	terminalEventStream = "terminal"
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
// { sessionId, agentId, event: <WireEvent> } (frozen contract F). cursorJSON is
// an optional resume cursor object ({epoch?, after_seq?}) carried to the sidecar
// stream hub as the listen arg: the hub replays journaled frames after
// after_seq, or pushes a resync_required control frame when it cannot cover the
// gap. An empty cursorJSON subscribes live from the current head. Re-subscribing
// an already-active product stream is a no-op (the existing cursor stands).
func (a *App) ProductSubscribe(sessionId, agentId, cursorJSON string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	arg, err := parseProductCursor(cursorJSON)
	if err != nil {
		return err
	}
	return a.subscribeProduct(client, sessionId, agentId, arg)
}

// ProductUnsubscribe detaches the session/agent product stream: it cancels the
// forwarding goroutine and tells the sidecar to dispose its projector
// subscription (Unlisten), so the stream hub can ref-count down and stop
// projecting when no consumer remains. Unsubscribing an inactive stream is a
// no-op.
func (a *App) ProductUnsubscribe(sessionId, agentId string) error {
	key := productSubKeyPrefix + sessionId + "/" + agentId
	a.mu.Lock()
	sub, ok := a.productSubs[key]
	delete(a.productSubs, key)
	a.mu.Unlock()
	if !ok {
		return nil
	}
	sub.cancel()
	if client := a.currentClient(); client != nil {
		_ = client.Unlisten(sub.listenID)
	}
	return nil
}

// ProductStreamStart starts a desktopProduct download stream (e.g. getFileBlob
// or getWorkspaceFileBlob) and returns the web-facing streamId immediately
// (Slice 5). argsJSON parses like ProductCall. Stream frames are re-emitted on
// the "kimi:stream" channel as they arrive: { streamId, type: "data", chunk,
// seq } per base64 chunk, { streamId, type: "end", meta: { mime, size,
// filename } } on completion, and { streamId, type: "error", code, msg } on
// failure. The webview correlates events by streamId and aborts a download
// with ProductStreamCancel.
func (a *App) ProductStreamStart(method, argsJSON string) (string, error) {
	client, err := a.requireClient()
	if err != nil {
		return "", err
	}
	arg, err := parseProductArgs(argsJSON)
	if err != nil {
		return "", err
	}
	streamID := a.nextProductStreamID()
	subCtx, cancel := context.WithCancel(context.Background())
	ch, ipcID, err := client.Stream(subCtx, ipcclient.Scope{}, productService, method, arg)
	if err != nil {
		cancel()
		return "", err
	}

	a.mu.Lock()
	a.productStreams[streamID] = productStream{cancel: cancel, ipcID: ipcID}
	a.mu.Unlock()

	go func() {
		defer func() {
			a.mu.Lock()
			delete(a.productStreams, streamID)
			a.mu.Unlock()
			cancel()
		}()
		for {
			select {
			case ev, ok := <-ch:
				if !ok {
					return
				}
				a.emitStreamEvent(streamID, ev)
			case <-subCtx.Done():
				return
			}
		}
	}()

	return streamID, nil
}

// ProductStreamCancel aborts an active product download stream: it stops the
// forwarding goroutine and tells the sidecar to dispose the stream
// (StreamCancel). Cancelling an unknown or already finished stream is a no-op.
func (a *App) ProductStreamCancel(streamID string) error {
	a.mu.Lock()
	ps, ok := a.productStreams[streamID]
	delete(a.productStreams, streamID)
	a.mu.Unlock()
	if !ok {
		return nil
	}
	ps.cancel()
	if client := a.currentClient(); client != nil {
		_ = client.StreamCancel(ps.ipcID)
	}
	return nil
}

// ProductTerminalAttach attaches a session terminal's output stream and
// re-emits each engine terminal frame on the dedicated "kimi:terminal" channel
// (Slice 6): output frames as { sessionId, terminalId, type: "output", data,
// seq }, exit frames as { sessionId, terminalId, type: "exit", exitCode }
// (exitCode null when the frame carries none). Terminal frames never cross the
// kimi:event chat channel. sinceSeqJSON is the optional resume sequence number
// as a JSON number carried to the sidecar attach as since_seq (empty or 0
// replays nothing); the sidecar host resolves the session terminal service and
// replays buffered frames after it. Attaching an already-attached terminal is
// a no-op (the existing subscription stands).
func (a *App) ProductTerminalAttach(sessionId, terminalId, sinceSeqJSON string) error {
	client, err := a.requireClient()
	if err != nil {
		return err
	}
	sinceSeq, err := parseTerminalSinceSeq(sinceSeqJSON)
	if err != nil {
		return err
	}
	return a.attachTerminal(client, sessionId, terminalId, sinceSeq)
}

// ProductTerminalDetach detaches a session terminal's output stream: it
// cancels the forwarding goroutine and tells the sidecar to dispose its sink
// (Unlisten). Detaching an unknown or already detached terminal is a no-op.
func (a *App) ProductTerminalDetach(sessionId, terminalId string) error {
	key := sessionId + "\x00" + terminalId
	a.mu.Lock()
	sub, ok := a.terminalSubs[key]
	delete(a.terminalSubs, key)
	a.mu.Unlock()
	if !ok {
		return nil
	}
	sub.cancel()
	if client := a.currentClient(); client != nil {
		_ = client.Unlisten(sub.listenID)
	}
	return nil
}

// productStream tracks one active product download stream: the context cancel
// that stops its forwarding goroutine and the ipc stream id used to
// StreamCancel the sidecar side. The web-facing streamId (the map key in
// App.productStreams) and the ipc stream id differ: the ipc id is generated by
// the ipcclient, the web-facing id by nextProductStreamID.
type productStream struct {
	cancel context.CancelFunc
	ipcID  string
}

// nextProductStreamID generates the web-facing product stream id: a
// nanosecond prefix plus a monotonic counter that disambiguates streams
// started within the same nanosecond.
func (a *App) nextProductStreamID() string {
	return fmt.Sprintf("ps_%x", time.Now().UnixNano()) + strconv.FormatUint(a.productStreamSeq.Add(1), 10)
}

// emitStreamEvent re-emits one ipc stream frame on the "kimi:stream" channel.
// data frames flatten the sidecar's { chunk, seq } payload to top-level chunk
// (base64) and seq fields; the end frame carries the sidecar's { mime, size,
// filename } payload as meta; error frames carry code and msg.
func (a *App) emitStreamEvent(streamID string, ev ipcclient.StreamEvent) {
	payload := map[string]any{
		"streamId": streamID,
		"type":     ev.Type,
	}
	switch ev.Type {
	case "data":
		var data map[string]any
		if json.Unmarshal(ev.Data, &data) == nil {
			if chunk, ok := data["chunk"].(string); ok {
				payload["chunk"] = chunk
			}
			if seq, ok := data["seq"]; ok && seq != nil {
				payload["seq"] = seq
			}
		}
	case "end":
		var meta map[string]any
		if json.Unmarshal(ev.Data, &meta) == nil && len(meta) > 0 {
			payload["meta"] = meta
		}
	case "error":
		payload["code"] = ev.Code
		payload["msg"] = ev.Msg
	}
	runtime.EventsEmit(a.ctx, streamChannel, payload)
}

// productSub tracks one active product subscription: the context cancel that
// stops its forwarding goroutine and the ipc subscription id used to Unlisten
// the sidecar side.
type productSub struct {
	cancel   context.CancelFunc
	listenID string
}

// subscribeProduct mirrors subscribe in app.go for the product stream. It is
// kept separate so the Phase 0 agent-event path stays untouched; the two share
// App.emit but track subscriptions in different maps (App.productSubs vs
// App.subs). Unlike subscribe it returns the listen error so ProductSubscribe
// can report a failed setup, and it records the ipc subscription id for
// ProductUnsubscribe.
func (a *App) subscribeProduct(client *ipcclient.Client, sessionId, agentId string, cursor []any) error {
	key := productSubKeyPrefix + sessionId + "/" + agentId

	a.mu.Lock()
	if _, ok := a.productSubs[key]; ok {
		a.mu.Unlock()
		return nil
	}
	a.mu.Unlock()

	subCtx, cancel := context.WithCancel(context.Background())
	ch, listenID, err := client.ListenWithCursor(subCtx,
		ipcclient.Scope{SessionID: sessionId, AgentID: agentId},
		productEventStream,
		cursor,
	)
	if err != nil {
		cancel()
		log.Printf("kimi-desktop: product listen failed for %s: %v", key, err)
		return err
	}

	a.mu.Lock()
	if _, ok := a.productSubs[key]; ok {
		// Lost a race to a concurrent ProductSubscribe; drop this one and
		// dispose the just-created sidecar subscription.
		a.mu.Unlock()
		cancel()
		_ = client.Unlisten(listenID)
		return nil
	}
	a.productSubs[key] = productSub{cancel: cancel, listenID: listenID}
	a.mu.Unlock()

	go func() {
		defer cancel()
		for ev := range ch {
			// ev.Data is already a kimi-web WireEvent (or resync_required control
			// frame) JSON; pass it through verbatim.
			a.emit(sessionId, agentId, ev.Data)
		}
	}()
	return nil
}

// parseProductCursor parses an optional resume-cursor payload into the
// positional listen arg the stream hub reads. Empty / blank input means no
// cursor (a fresh live subscription, arg nil). A JSON object is wrapped as a
// single-element positional array; an empty object also means no cursor.
// Anything else is rejected so a malformed payload fails fast.
func parseProductCursor(cursorJSON string) ([]any, error) {
	trimmed := strings.TrimSpace(cursorJSON)
	if trimmed == "" {
		return nil, nil
	}
	if trimmed[0] != '{' {
		return nil, fmt.Errorf("product cursor: expected a JSON object, got %q", trimmed[0])
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
		return nil, fmt.Errorf("product cursor: %w", err)
	}
	if len(obj) == 0 {
		return nil, nil
	}
	return []any{obj}, nil
}

// terminalSub tracks one active terminal attach subscription: the context
// cancel that stops its forwarding goroutine and the ipc subscription id used
// to Unlisten the sidecar side.
type terminalSub struct {
	cancel   context.CancelFunc
	listenID string
}

// attachTerminal mirrors subscribeProduct for the session terminal feed. It is
// kept separate so the product stream path stays untouched; subscriptions are
// tracked in App.terminalSubs keyed by sessionId + "\x00" + terminalId. Unlike
// the product stream (session/agent scoped) the terminal feed is session
// scoped, and each pushed frame is re-emitted on the dedicated kimi:terminal
// channel rather than kimi:event.
func (a *App) attachTerminal(client *ipcclient.Client, sessionId, terminalId string, sinceSeq int64) error {
	key := sessionId + "\x00" + terminalId

	a.mu.Lock()
	if _, ok := a.terminalSubs[key]; ok {
		a.mu.Unlock()
		return nil
	}
	a.mu.Unlock()

	// The sidecar host reads arg[0] for { terminal_id, since_seq }; since_seq
	// is omitted when 0 so the host attaches without replay.
	listenArg := map[string]any{"terminal_id": terminalId}
	if sinceSeq > 0 {
		listenArg["since_seq"] = sinceSeq
	}

	subCtx, cancel := context.WithCancel(context.Background())
	ch, listenID, err := client.ListenWithCursor(subCtx,
		ipcclient.Scope{SessionID: sessionId},
		terminalEventStream,
		[]any{listenArg},
	)
	if err != nil {
		cancel()
		log.Printf("kimi-desktop: terminal listen failed for %s: %v", key, err)
		return err
	}

	a.mu.Lock()
	if _, ok := a.terminalSubs[key]; ok {
		// Lost a race to a concurrent attach; drop this one and dispose the
		// just-created sidecar subscription.
		a.mu.Unlock()
		cancel()
		_ = client.Unlisten(listenID)
		return nil
	}
	a.terminalSubs[key] = terminalSub{cancel: cancel, listenID: listenID}
	a.mu.Unlock()

	go func() {
		defer cancel()
		for ev := range ch {
			a.emitTerminalFrame(ev.Data)
		}
	}()
	return nil
}

// terminalFrame is the engine TerminalFrame wire shape (snake_case): a
// terminal_output frame carries seq and payload.data, a terminal_exit frame
// payload.exit_code. Only the fields the kimi:terminal re-emit needs are
// decoded; strong typing is deferred like the rest of the Go passthrough.
type terminalFrame struct {
	Type       string `json:"type"`
	Seq        int64  `json:"seq"`
	SessionID  string `json:"session_id"`
	TerminalID string `json:"terminal_id"`
	Payload    struct {
		Data     string `json:"data"`
		ExitCode *int64 `json:"exit_code"`
	} `json:"payload"`
}

// emitTerminalFrame re-emits one engine terminal frame on the "kimi:terminal"
// channel, mapping the engine frame types to the web-facing ones
// (terminal_output → "output", terminal_exit → "exit"). sessionId and
// terminalId are extracted from the frame itself. Malformed frames and unknown
// types are dropped.
func (a *App) emitTerminalFrame(data json.RawMessage) {
	var frame terminalFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		return
	}
	payload := map[string]any{
		"sessionId":  frame.SessionID,
		"terminalId": frame.TerminalID,
	}
	switch frame.Type {
	case "terminal_output":
		payload["type"] = "output"
		payload["data"] = frame.Payload.Data
		payload["seq"] = frame.Seq
	case "terminal_exit":
		payload["type"] = "exit"
		var exitCode any
		if frame.Payload.ExitCode != nil {
			exitCode = *frame.Payload.ExitCode
		}
		payload["exitCode"] = exitCode
	default:
		return
	}
	runtime.EventsEmit(a.ctx, terminalChannel, payload)
}

// parseTerminalSinceSeq parses the optional resume sequence number for a
// terminal attach. Empty or blank input means 0 (attach without replay); a
// JSON number is used as-is. Anything else is rejected so a malformed payload
// fails fast.
func parseTerminalSinceSeq(sinceSeqJSON string) (int64, error) {
	trimmed := strings.TrimSpace(sinceSeqJSON)
	if trimmed == "" {
		return 0, nil
	}
	if trimmed[0] < '0' || trimmed[0] > '9' {
		return 0, fmt.Errorf("terminal since_seq: expected a JSON number, got %q", trimmed[0])
	}
	var num json.Number
	if err := json.Unmarshal([]byte(trimmed), &num); err != nil {
		return 0, fmt.Errorf("terminal since_seq: %w", err)
	}
	seq, err := num.Int64()
	if err != nil {
		return 0, fmt.Errorf("terminal since_seq: %w", err)
	}
	return seq, nil
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
