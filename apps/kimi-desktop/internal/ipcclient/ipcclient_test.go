package ipcclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"
)

// fakeServer is an in-process klient-ipc host speaking NDJSON over loopback
// TCP. It mirrors the bits of serveKlientIpc the client relies on: `ready`
// on connect, the hello token check, call/result/error correlation, and
// listen/listen_result/event routing.
type fakeServer struct {
	t     *testing.T
	ln    net.Listener
	token string

	mu        sync.Mutex
	gotHello  string
	calls     []frame
	listens   []frame
	unlistens []string
}

func startFakeServer(t *testing.T, token string) (*fakeServer, string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp: %v", err)
	}
	s := &fakeServer{t: t, ln: ln, token: token}
	go s.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return s, fmt.Sprintf("tcp://%s", ln.Addr().String())
}

func (s *fakeServer) serve() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *fakeServer) handle(conn net.Conn) {
	defer conn.Close()
	write := func(f frame) {
		b, err := json.Marshal(f)
		if err != nil {
			return
		}
		b = append(b, '\n')
		_, _ = conn.Write(b)
	}

	write(frame{Type: "ready"})

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 16<<20)
	helloOK := false
	for scanner.Scan() {
		var f frame
		if json.Unmarshal(scanner.Bytes(), &f) != nil {
			continue
		}
		switch f.Type {
		case "hello":
			if s.token != "" && f.Token != s.token {
				write(frame{Type: "error", ID: "hello", Code: 40100, Msg: "unauthorized"})
				return
			}
			helloOK = true
			s.mu.Lock()
			s.gotHello = f.Token
			s.mu.Unlock()
		case "call":
			if !helloOK {
				write(frame{Type: "error", ID: f.ID, Code: 40001, Msg: "expected hello first"})
				continue
			}
			s.mu.Lock()
			s.calls = append(s.calls, f)
			s.mu.Unlock()
			switch f.Method {
			case "boom":
				write(frame{Type: "error", ID: f.ID, Code: 12345, Msg: "kaboom"})
			case "probe":
				data, _ := json.Marshal(map[string]any{
					"scope":     f.Scope,
					"sessionId": f.SessionID,
					"agentId":   f.AgentID,
				})
				write(frame{Type: "result", ID: f.ID, Data: data})
			case "slow":
				time.Sleep(300 * time.Millisecond)
				write(frame{Type: "result", ID: f.ID, Data: json.RawMessage(`{"slow":true}`)})
			default:
				write(frame{Type: "result", ID: f.ID, Data: json.RawMessage(`{"ok":true}`)})
			}
		case "listen":
			s.mu.Lock()
			s.listens = append(s.listens, f)
			s.mu.Unlock()
			write(frame{Type: "listen_result", ID: f.ID})
			write(frame{Type: "event", ID: f.ID, Data: json.RawMessage(`{"type":"assistant.delta","delta":"he"}`)})
			write(frame{Type: "event", ID: f.ID, Data: json.RawMessage(`{"type":"assistant.delta","delta":"llo"}`)})
		case "unlisten":
			s.mu.Lock()
			s.unlistens = append(s.unlistens, f.ID)
			s.mu.Unlock()
		}
	}
}

func dial(t *testing.T, sock, token string) *Client {
	t.Helper()
	c, err := Dial(context.Background(), sock, token)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestDialHandshakeAndCallResult(t *testing.T) {
	s, sock := startFakeServer(t, "tok")
	c := dial(t, sock, "tok")

	res, err := c.Call(context.Background(), Scope{}, "svc", "ping", nil)
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if string(res) != `{"ok":true}` {
		t.Fatalf("result = %s, want {\"ok\":true}", res)
	}

	s.mu.Lock()
	gotHello := s.gotHello
	s.mu.Unlock()
	if gotHello != "tok" {
		t.Fatalf("server saw hello token %q, want %q", gotHello, "tok")
	}
}

func TestCallError(t *testing.T) {
	_, sock := startFakeServer(t, "")
	c := dial(t, sock, "")

	_, err := c.Call(context.Background(), Scope{}, "svc", "boom", nil)
	var rpc *RPCError
	if !errors.As(err, &rpc) {
		t.Fatalf("Call error = %v, want *RPCError", err)
	}
	if rpc.Code != 12345 || rpc.Msg != "kaboom" {
		t.Fatalf("RPCError = {%d %q}, want {12345 \"kaboom\"}", rpc.Code, rpc.Msg)
	}
}

func TestScopeDerivationAndArgTrim(t *testing.T) {
	s, sock := startFakeServer(t, "")
	c := dial(t, sock, "")
	ctx := context.Background()

	if _, err := c.Call(ctx, Scope{}, "svc", "probe", nil); err != nil {
		t.Fatalf("core call: %v", err)
	}
	if _, err := c.Call(ctx, Scope{SessionID: "s1"}, "svc", "probe", nil); err != nil {
		t.Fatalf("session call: %v", err)
	}
	if _, err := c.Call(ctx, Scope{SessionID: "s1", AgentID: "a1"}, "svc", "probe", []any{"x", nil}); err != nil {
		t.Fatalf("agent call: %v", err)
	}

	s.mu.Lock()
	calls := append([]frame(nil), s.calls...)
	s.mu.Unlock()
	if len(calls) != 3 {
		t.Fatalf("server saw %d calls, want 3", len(calls))
	}

	core, sess, agent := calls[0], calls[1], calls[2]
	if core.Scope != "core" || core.SessionID != "" || core.AgentID != "" {
		t.Fatalf("core scope frame = %+v", core)
	}
	if sess.Scope != "session" || sess.SessionID != "s1" || sess.AgentID != "" {
		t.Fatalf("session scope frame = %+v", sess)
	}
	if agent.Scope != "agent" || agent.SessionID != "s1" || agent.AgentID != "a1" {
		t.Fatalf("agent scope frame = %+v", agent)
	}
	// Trailing nil arg trimmed; the single real arg survives.
	if len(agent.Arg) != 1 || agent.Arg[0] != "x" {
		t.Fatalf("agent arg = %#v, want [\"x\"]", agent.Arg)
	}
}

func TestListenDeliversEvents(t *testing.T) {
	s, sock := startFakeServer(t, "")
	c := dial(t, sock, "")

	ch, err := c.Listen(context.Background(), Scope{SessionID: "s1", AgentID: "a1"}, "events")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}

	var subID string
	var deltas []string
	for i := 0; i < 2; i++ {
		select {
		case ev := <-ch:
			subID = ev.ID
			deltas = append(deltas, string(ev.Data))
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for event %d", i)
		}
	}
	if subID == "" {
		t.Fatalf("event carried empty subscription id")
	}
	if deltas[0] != `{"type":"assistant.delta","delta":"he"}` || deltas[1] != `{"type":"assistant.delta","delta":"llo"}` {
		t.Fatalf("deltas = %v", deltas)
	}

	s.mu.Lock()
	listens := append([]frame(nil), s.listens...)
	s.mu.Unlock()
	if len(listens) != 1 {
		t.Fatalf("server saw %d listens, want 1", len(listens))
	}
	lf := listens[0]
	if lf.Scope != "agent" || lf.SessionID != "s1" || lf.AgentID != "a1" || lf.Event != "events" {
		t.Fatalf("listen frame = %+v, want agent/s1/a1/events", lf)
	}

	// Unlisten with the id echoed on the event frames.
	if err := c.Unlisten(subID); err != nil {
		t.Fatalf("Unlisten: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		got := append([]string(nil), s.unlistens...)
		s.mu.Unlock()
		if len(got) == 1 && got[0] == subID {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("server did not receive unlisten for %q, got %v", subID, got)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestListenWithCursorCarriesArgAndReturnsID(t *testing.T) {
	s, sock := startFakeServer(t, "")
	c := dial(t, sock, "")

	cursor := []any{map[string]any{"epoch": "ep_1", "after_seq": float64(7)}}
	ch, id, err := c.ListenWithCursor(
		context.Background(),
		Scope{SessionID: "s1", AgentID: "a1"},
		"product",
		cursor,
	)
	if err != nil {
		t.Fatalf("ListenWithCursor: %v", err)
	}
	if id == "" {
		t.Fatalf("ListenWithCursor returned empty subscription id")
	}

	// Drain the first canned event so the id is confirmed on the wire too.
	select {
	case ev := <-ch:
		if ev.ID != id {
			t.Fatalf("event id = %q, want %q", ev.ID, id)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first event")
	}

	s.mu.Lock()
	listens := append([]frame(nil), s.listens...)
	s.mu.Unlock()
	if len(listens) != 1 {
		t.Fatalf("server saw %d listens, want 1", len(listens))
	}
	lf := listens[0]
	if lf.Event != "product" || lf.SessionID != "s1" || lf.AgentID != "a1" {
		t.Fatalf("listen frame = %+v, want product/s1/a1", lf)
	}
	if len(lf.Arg) != 1 {
		t.Fatalf("listen arg = %#v, want one cursor object", lf.Arg)
	}
	obj, ok := lf.Arg[0].(map[string]any)
	if !ok || obj["epoch"] != "ep_1" || obj["after_seq"] != float64(7) {
		t.Fatalf("listen arg[0] = %#v, want {epoch:ep_1, after_seq:7}", lf.Arg[0])
	}

	// The returned id must Unlisten the subscription.
	if err := c.Unlisten(id); err != nil {
		t.Fatalf("Unlisten: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		got := append([]string(nil), s.unlistens...)
		s.mu.Unlock()
		if len(got) == 1 && got[0] == id {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("server did not receive unlisten for %q, got %v", id, got)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWrongTokenRejected(t *testing.T) {
	_, sock := startFakeServer(t, "secret")

	// Dial completes the handshake by sending hello; like the TS reference it
	// does not block on the host's auth verdict, so the rejection surfaces on
	// the first call (the host closes the socket after error{id:"hello"}).
	c, err := Dial(context.Background(), sock, "wrong")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	if _, err := c.Call(context.Background(), Scope{}, "svc", "ping", nil); err == nil {
		t.Fatalf("expected call to fail after token rejection")
	}
}

func TestCloseFailsInFlightCall(t *testing.T) {
	_, sock := startFakeServer(t, "")
	c, err := Dial(context.Background(), sock, "")
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := c.Call(context.Background(), Scope{}, "svc", "slow", nil)
		done <- err
	}()

	time.Sleep(50 * time.Millisecond) // let the call register and reach the server
	_ = c.Close()

	select {
	case err := <-done:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("in-flight call error = %v, want ErrClosed", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("in-flight call did not fail after Close")
	}
}

func TestCallContextCancel(t *testing.T) {
	_, sock := startFakeServer(t, "")
	c := dial(t, sock, "")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := c.Call(ctx, Scope{}, "svc", "slow", nil)
		done <- err
	}()

	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled call error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("cancelled call did not return")
	}
}
