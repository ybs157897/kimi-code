// Package ipcclient is a Go client for the klient-ipc frame protocol: NDJSON
// over a local socket, one connection multiplexing RPC calls, event
// subscriptions, and streaming calls. It mirrors packages/klient/src/
// transports/ipc (codec.ts for the frame schema, channel.ts for the reference
// client): the host sends `ready` on connect, the client answers
// `hello{token}`, then `call` / `listen` / `unlisten` / `stream` /
// `stream_cancel` frames are correlated by client-chosen ids. There is no
// reconnect — a broken socket fails in-flight calls and closes subscription
// and stream channels (the resumable-connection story lives elsewhere).
package ipcclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// maxFrameBytes caps a single NDJSON line. Frames carry arbitrary engine
// payloads (tool output, event data), so allow generously; bufio.Scanner grows
// into this lazily rather than preallocating.
const maxFrameBytes = 256 << 20 // 256 MiB

// eventBuffer is the per-subscription channel capacity. Event sends block once
// the buffer is full (the protocol has no backpressure), mirroring the TS
// client whose synchronous handler stalls the socket when the consumer is slow.
const eventBuffer = 64

// ErrClosed is returned once the client has been closed or the socket broke.
var ErrClosed = errors.New("ipcclient: connection closed")

// RPCError is a host-reported `error` frame, mirroring the klient RPCError: the
// numeric Code is the stable branch key across the wire, not the message text.
type RPCError struct {
	Code int
	Msg  string
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("ipcclient: rpc error %d: %s", e.Code, e.Msg)
}

// Scope selects the engine scope a call or subscription targets. Derivation
// matches the host: a non-empty AgentID means "agent", else a non-empty
// SessionID means "session", else "core".
type Scope struct {
	SessionID string // "" => core/session scope
	AgentID   string // non-empty => agent scope
}

func (s Scope) kind() string {
	switch {
	case s.AgentID != "":
		return "agent"
	case s.SessionID != "":
		return "session"
	default:
		return "core"
	}
}

// Event is one pushed event for a subscription. Data is the raw klient event
// object (the whole flat `{ type, ... }` payload); strong typing is deferred.
type Event struct {
	ID   string          // subscription id
	Data json.RawMessage // event payload (klient event object)
}

// StreamEvent is one delivered frame of a streaming procedure started with
// Stream. Type discriminates: "data" carries a stream_data payload in Data,
// "end" the stream_end payload (may be empty), and "error" the host's
// stream_error Code/Msg. The channel closes right after an "end" or "error"
// event, or on connection teardown.
type StreamEvent struct {
	ID   string          // stream id
	Type string          // "data" | "end" | "error"
	Data json.RawMessage // stream_data / stream_end payload
	Code int             // stream_error code (Type == "error" only)
	Msg  string          // stream_error message (Type == "error" only)
}

// frame is the NDJSON wire message. Type discriminates; the remaining fields
// are sparse and omitted when empty, matching JSON.stringify dropping undefined
// fields in the TS codec. Empty SessionID/AgentID are omitted on purpose so the
// host does not mistake "" for a present coordinate.
type frame struct {
	Type      string          `json:"type"`
	ID        string          `json:"id,omitempty"`
	Scope     string          `json:"scope,omitempty"`
	Service   string          `json:"service,omitempty"`
	Method    string          `json:"method,omitempty"`
	Arg       []any           `json:"arg,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	AgentID   string          `json:"agentId,omitempty"`
	Event     string          `json:"event,omitempty"`
	Token     string          `json:"token,omitempty"`
	Code      int             `json:"code,omitempty"`
	Msg       string          `json:"msg,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

type callResult struct {
	data json.RawMessage
	err  error
}

type subscription struct {
	events chan Event
	// ack receives nil on `listen_result` or an *RPCError on a setup `error`;
	// buffered so the reader never blocks delivering it.
	ack chan error
	// established flips once `listen_result` arrives; a later `error` is a
	// runtime subscription failure that terminates the stream.
	established bool
}

// Client is a connected klient-ipc channel. The exported method set is the
// frozen Phase 0 interface consumed by the Wails shell.
type Client struct {
	conn     net.Conn
	idPrefix string
	idSeq    atomic.Uint64

	writeMu sync.Mutex // serializes conn writes

	mu      sync.Mutex
	pending map[string]chan callResult
	subs    map[string]*subscription
	streams map[string]chan StreamEvent

	closed    atomic.Bool
	readyCh   chan struct{} // closed on the host's `ready` frame
	dead      chan struct{} // closed once the connection is torn down
	closeOnce sync.Once
}

// Dial connects to a tcp:// loopback endpoint or Unix socket path and completes
// the hello handshake. It waits
// for the host's `ready` frame, then sends `hello{token}` (token omitted when
// empty). Waiting for ready — rather than hello-on-connect — matches the
// documented order and lets Dial surface a socket that closes mid-handshake.
func Dial(ctx context.Context, endpoint, token string) (*Client, error) {
	conn, err := dialEndpoint(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	c := &Client{
		conn:     conn,
		idPrefix: fmt.Sprintf("g%x", time.Now().UnixNano()),
		pending:  make(map[string]chan callResult),
		subs:     make(map[string]*subscription),
		streams:  make(map[string]chan StreamEvent),
		readyCh:  make(chan struct{}),
		dead:     make(chan struct{}),
	}
	go c.readLoop()

	select {
	case <-c.readyCh:
	case <-c.dead:
		return nil, ErrClosed
	case <-ctx.Done():
		c.teardown(ctx.Err())
		return nil, ctx.Err()
	}

	c.send(frame{Type: "hello", Token: token})
	return c, nil
}

func dialEndpoint(ctx context.Context, endpoint string) (net.Conn, error) {
	var dialer net.Dialer
	if !strings.HasPrefix(endpoint, "tcp://") {
		return dialer.DialContext(ctx, "unix", endpoint)
	}

	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("ipcclient: parse endpoint: %w", err)
	}
	host := parsed.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return nil, fmt.Errorf("ipcclient: endpoint must be loopback: %q", host)
	}
	if parsed.Port() == "" {
		return nil, errors.New("ipcclient: tcp endpoint is missing a port")
	}
	return dialer.DialContext(ctx, "tcp", parsed.Host)
}

// Call invokes a klient procedure and returns its raw JSON result.
func (c *Client) Call(ctx context.Context, s Scope, service, method string, arg []any) (json.RawMessage, error) {
	if c.closed.Load() {
		return nil, ErrClosed
	}
	id := c.nextID()
	ch := make(chan callResult, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()

	c.send(frame{
		Type:      "call",
		ID:        id,
		Scope:     s.kind(),
		Service:   service,
		Method:    method,
		Arg:       trimTrailingNil(arg),
		SessionID: s.SessionID,
		AgentID:   s.AgentID,
	})

	select {
	case res := <-ch:
		return res.data, res.err
	case <-c.dead:
		c.dropPending(id)
		return nil, ErrClosed
	case <-ctx.Done():
		c.dropPending(id)
		return nil, ctx.Err()
	}
}

// Listen subscribes to an event stream; events are delivered to the returned
// channel. For agent events use Scope{SessionID, AgentID} with event "events".
// The channel is closed when the subscription ends (connection teardown or a
// runtime subscription error). The subscription id — needed for Unlisten — is
// carried on every delivered Event.ID.
func (c *Client) Listen(ctx context.Context, s Scope, event string) (<-chan Event, error) {
	ch, _, err := c.listen(ctx, s, event, nil)
	return ch, err
}

// ListenWithCursor subscribes like Listen but carries a positional arg (e.g. a
// resume cursor for the product stream: {epoch?, after_seq?}) and returns the
// subscription id up front, so the caller can Unlisten it without waiting for
// the first event. An empty arg behaves exactly like Listen.
func (c *Client) ListenWithCursor(ctx context.Context, s Scope, event string, arg []any) (<-chan Event, string, error) {
	return c.listen(ctx, s, event, arg)
}

// listen is the shared subscription implementation. It sends the listen frame
// (optionally carrying arg), waits for the host's ack, and returns the event
// channel plus the subscription id.
func (c *Client) listen(ctx context.Context, s Scope, event string, arg []any) (<-chan Event, string, error) {
	if c.closed.Load() {
		return nil, "", ErrClosed
	}
	id := c.nextID()
	sub := &subscription{
		events: make(chan Event, eventBuffer),
		ack:    make(chan error, 1),
	}
	c.mu.Lock()
	c.subs[id] = sub
	c.mu.Unlock()

	c.send(frame{
		Type:      "listen",
		ID:        id,
		Scope:     s.kind(),
		SessionID: s.SessionID,
		AgentID:   s.AgentID,
		Event:     event,
		Arg:       trimTrailingNil(arg),
	})

	select {
	case err := <-sub.ack:
		if err != nil {
			c.dropSub(id)
			return nil, "", err
		}
		return sub.events, id, nil
	case <-c.dead:
		c.dropSub(id)
		return nil, "", ErrClosed
	case <-ctx.Done():
		c.dropSub(id)
		return nil, "", ctx.Err()
	}
}

// The frozen Listen signature returns only the channel, not the subscription
// id; a caller learns the id from Event.ID (echoed on every event frame) and
// passes it to Unlisten.
func (c *Client) dropSub(id string) {
	c.mu.Lock()
	delete(c.subs, id)
	c.mu.Unlock()
}

func (c *Client) dropPending(id string) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

// Unlisten stops the subscription registered under id and tells the host to
// dispose its side. The event channel is not closed here (the reader goroutine
// owns channel closure to stay race-free); it is closed on connection teardown.
// Unlistening an unknown id is a no-op.
func (c *Client) Unlisten(id string) error {
	if c.closed.Load() {
		return ErrClosed
	}
	c.mu.Lock()
	_, ok := c.subs[id]
	delete(c.subs, id)
	c.mu.Unlock()
	if !ok {
		return nil
	}
	c.send(frame{Type: "unlisten", ID: id})
	return nil
}

// Stream starts a streaming procedure and returns its event channel plus the
// stream id (for StreamCancel). Unlike Call there is no setup ack on the wire:
// a setup failure arrives as an ordinary "error" StreamEvent on the channel.
// The channel is closed when the stream finishes (stream_end / stream_error)
// or the connection is torn down.
//
// The host sends no confirmation for stream_cancel, so StreamCancel does NOT
// close the channel: like Unlisten, it detaches the stream (late frames are
// dropped) and the consumer must stop waiting on its own signal — e.g. select
// on the context it passed here. ctx is validated up front; cancelling it does
// not talk to the host, call StreamCancel for that.
func (c *Client) Stream(ctx context.Context, s Scope, service, method string, arg []any) (<-chan StreamEvent, string, error) {
	if c.closed.Load() {
		return nil, "", ErrClosed
	}
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	id := c.nextID()
	ch := make(chan StreamEvent, eventBuffer)
	c.mu.Lock()
	c.streams[id] = ch
	c.mu.Unlock()

	c.send(frame{
		Type:      "stream",
		ID:        id,
		Scope:     s.kind(),
		Service:   service,
		Method:    method,
		Arg:       trimTrailingNil(arg),
		SessionID: s.SessionID,
		AgentID:   s.AgentID,
	})
	return ch, id, nil
}

// StreamCancel tells the host to abort the stream registered under id. The
// stream is detached: later stream_data/stream_end/stream_error frames for it
// are dropped and the channel is left unclosed for the GC (the consumer should
// exit on its own signal, see Stream). Cancelling an unknown or already
// finished stream is a no-op.
func (c *Client) StreamCancel(id string) error {
	if c.closed.Load() {
		return ErrClosed
	}
	c.mu.Lock()
	_, ok := c.streams[id]
	delete(c.streams, id)
	c.mu.Unlock()
	if !ok {
		return nil
	}
	c.send(frame{Type: "stream_cancel", ID: id})
	return nil
}

// Close tears down the connection: in-flight calls fail with ErrClosed and the
// socket is closed. The reader goroutine closes every subscription channel as
// it exits. Close is idempotent.
func (c *Client) Close() error {
	c.teardown(ErrClosed)
	return nil
}

// teardown fails in-flight calls and closes the socket exactly once. The reader
// goroutine calls it on EOF/error too; subscription channels are closed by the
// reader as it exits (single owner), not here.
func (c *Client) teardown(cause error) {
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		close(c.dead)

		c.mu.Lock()
		pending := c.pending
		c.pending = make(map[string]chan callResult)
		c.mu.Unlock()
		for _, ch := range pending {
			select {
			case ch <- callResult{err: cause}:
			default:
			}
		}

		_ = c.conn.Close()
	})
}

func (c *Client) nextID() string {
	return fmt.Sprintf("%s_%d", c.idPrefix, c.idSeq.Add(1))
}

func (c *Client) send(f frame) {
	if c.closed.Load() {
		return
	}
	b, err := json.Marshal(f)
	if err != nil {
		return
	}
	b = append(b, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed.Load() {
		return
	}
	_, _ = c.conn.Write(b)
}

// readLoop decodes NDJSON frames and dispatches them until the socket closes,
// then tears down and closes every remaining subscription channel.
func (c *Client) readLoop() {
	scanner := bufio.NewScanner(c.conn)
	scanner.Buffer(make([]byte, 0, 64*1024), maxFrameBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var f frame
		if json.Unmarshal(line, &f) != nil {
			continue // drop malformed frames, matching the TS decoder
		}
		c.dispatch(f)
	}
	// EOF or read error: fail in-flight calls, then close subscription and
	// stream channels (this goroutine is their sole sender and closer).
	c.teardown(ErrClosed)
	c.mu.Lock()
	subs := c.subs
	c.subs = make(map[string]*subscription)
	streams := c.streams
	c.streams = make(map[string]chan StreamEvent)
	c.mu.Unlock()
	for _, sub := range subs {
		if !sub.established {
			select {
			case sub.ack <- ErrClosed:
			default:
			}
		}
		close(sub.events)
	}
	for _, ch := range streams {
		close(ch)
	}
}

func (c *Client) dispatch(f frame) {
	switch f.Type {
	case "ready":
		select {
		case <-c.readyCh:
		default:
			close(c.readyCh)
		}
	case "result":
		c.mu.Lock()
		ch := c.pending[f.ID]
		delete(c.pending, f.ID)
		c.mu.Unlock()
		if ch != nil {
			select {
			case ch <- callResult{data: f.Data}:
			default:
			}
		}
	case "error":
		rpcErr := &RPCError{Code: f.Code, Msg: f.Msg}
		if rpcErr.Code == 0 {
			rpcErr.Code = 50001
		}
		if rpcErr.Msg == "" {
			rpcErr.Msg = "error"
		}
		c.mu.Lock()
		ch := c.pending[f.ID]
		delete(c.pending, f.ID)
		sub := c.subs[f.ID]
		if sub != nil && !sub.established {
			// A setup failure: Listen is still waiting on ack.
			delete(c.subs, f.ID)
		}
		c.mu.Unlock()
		if ch != nil {
			select {
			case ch <- callResult{err: rpcErr}:
			default:
			}
			return
		}
		if sub != nil {
			if sub.established {
				// Runtime subscription failure terminates the stream.
				close(sub.events)
			} else {
				select {
				case sub.ack <- rpcErr:
				default:
				}
			}
		}
	case "listen_result":
		c.mu.Lock()
		sub := c.subs[f.ID]
		if sub != nil {
			sub.established = true
		}
		c.mu.Unlock()
		if sub != nil {
			select {
			case sub.ack <- nil:
			default:
			}
		}
	case "event":
		c.mu.Lock()
		sub := c.subs[f.ID]
		c.mu.Unlock()
		if sub == nil {
			return
		}
		select {
		case sub.events <- Event{ID: f.ID, Data: f.Data}:
		case <-c.dead:
		}
	case "stream_data":
		c.mu.Lock()
		ch := c.streams[f.ID]
		c.mu.Unlock()
		if ch == nil {
			return
		}
		select {
		case ch <- StreamEvent{ID: f.ID, Type: "data", Data: f.Data}:
		case <-c.dead:
		}
	case "stream_end", "stream_error":
		c.mu.Lock()
		ch := c.streams[f.ID]
		delete(c.streams, f.ID)
		c.mu.Unlock()
		if ch == nil {
			return
		}
		ev := StreamEvent{ID: f.ID, Type: "end", Data: f.Data}
		if f.Type == "stream_error" {
			ev.Type = "error"
			ev.Data = nil
			ev.Code = f.Code
			ev.Msg = f.Msg
			if ev.Code == 0 {
				ev.Code = 50001
			}
			if ev.Msg == "" {
				ev.Msg = "error"
			}
		}
		select {
		case ch <- ev:
		case <-c.dead:
		}
		close(ch)
	default:
		// Unknown frame types are ignored, matching the TS decoder.
	}
}

// trimTrailingNil mirrors the TS trimTrailingUndefined: JSON has no undefined,
// so a trailing optional arg would cross as null and defeat host-side default
// parameters. Contracts only make trailing args optional, so trimming the tail
// suffices.
func trimTrailingNil(args []any) []any {
	end := len(args)
	for end > 0 && args[end-1] == nil {
		end--
	}
	return args[:end]
}
