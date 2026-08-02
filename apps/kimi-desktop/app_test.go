// App lifecycle tests — the Wails control plane becomes ready after its first
// sidecar boot attempt and never reports a failed IPC recovery as connected.
// The sidecar process and IPC socket are the only substituted boundaries.
// Run with `go test ./...` from apps/kimi-desktop.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"kimi-desktop/internal/ipcclient"
)

type fakeSidecarProcess struct {
	startErr error
}

func (s *fakeSidecarProcess) Start(context.Context) error { return s.startErr }
func (s *fakeSidecarProcess) Stop()                       {}
func (s *fakeSidecarProcess) Endpoint() string            { return "test-endpoint" }
func (s *fakeSidecarProcess) Token() string               { return "test-token" }

type fakeIPCClient struct {
	done            chan struct{}
	closeOnce       sync.Once
	managerObserved chan struct{}
	observeOnce     sync.Once
}

func newFakeIPCClient(managerObserved chan struct{}) *fakeIPCClient {
	return &fakeIPCClient{done: make(chan struct{}), managerObserved: managerObserved}
}

func (c *fakeIPCClient) Call(
	context.Context,
	ipcclient.Scope,
	string,
	string,
	[]any,
) (json.RawMessage, error) {
	return json.RawMessage(`{"items":[]}`), nil
}

func (c *fakeIPCClient) Listen(
	context.Context,
	ipcclient.Scope,
	string,
) (<-chan ipcclient.Event, error) {
	return nil, errors.New("not implemented by lifecycle test")
}

func (c *fakeIPCClient) ListenWithCursor(
	context.Context,
	ipcclient.Scope,
	string,
	[]any,
) (<-chan ipcclient.Event, string, error) {
	return nil, "", errors.New("not implemented by lifecycle test")
}

func (c *fakeIPCClient) Unlisten(string) error { return nil }

func (c *fakeIPCClient) Stream(
	context.Context,
	ipcclient.Scope,
	string,
	string,
	[]any,
) (<-chan ipcclient.StreamEvent, string, error) {
	return nil, "", errors.New("not implemented by lifecycle test")
}

func (c *fakeIPCClient) StreamCancel(string) error { return nil }

func (c *fakeIPCClient) Close() error {
	c.closeOnce.Do(func() { close(c.done) })
	return nil
}

func (c *fakeIPCClient) Done() <-chan struct{} {
	if c.managerObserved != nil {
		c.observeOnce.Do(func() { close(c.managerObserved) })
	}
	return c.done
}

func TestSelectDirectoryUsesNativePickerOptions(t *testing.T) {
	app := NewApp()
	app.ctx = context.Background()

	var got runtime.OpenDialogOptions
	app.pickDir = func(_ context.Context, options runtime.OpenDialogOptions) (string, error) {
		got = options
		return `C:\workspace`, nil
	}

	path, err := app.SelectDirectory("Choose a workspace", `C:\projects`)
	if err != nil {
		t.Fatalf("SelectDirectory() error = %v", err)
	}
	if path != `C:\workspace` {
		t.Fatalf("SelectDirectory() path = %q, want %q", path, `C:\workspace`)
	}
	if got.Title != "Choose a workspace" {
		t.Fatalf("SelectDirectory() title = %q", got.Title)
	}
	if got.DefaultDirectory != `C:\projects` {
		t.Fatalf("SelectDirectory() default directory = %q", got.DefaultDirectory)
	}
	if !got.CanCreateDirectories {
		t.Fatal("SelectDirectory() did not allow creating directories")
	}
}

func TestSelectDirectoryRejectsCallsBeforeStartup(t *testing.T) {
	app := NewApp()
	if _, err := app.SelectDirectory("Choose a workspace", ""); err == nil {
		t.Fatal("SelectDirectory() before startup returned no error")
	}
}

func TestAppLifecycleSignalsReadyAfterFirstBootAttempt(t *testing.T) {
	managerObserved := make(chan struct{})
	client := newFakeIPCClient(managerObserved)
	app := NewApp()
	app.sidecar = &fakeSidecarProcess{}
	app.dialIPC = func(context.Context, string, string) (ipcClient, error) {
		return client, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		app.shutdown(context.Background())
	})

	app.startup(ctx)
	// Done() is observed only after boot installed the client and entered the
	// long-running connection manager.
	<-managerObserved

	select {
	case <-app.ready:
	default:
		t.Fatal("App.ready remained open after the first boot attempt")
	}

	got, err := app.ListSessions()
	if err != nil {
		t.Fatalf("ListSessions() after ready: %v", err)
	}
	if got != `{"items":[]}` {
		t.Fatalf("ListSessions() = %s, want empty session page", got)
	}
}

func TestAppEnsureConnectedReportsDisconnectedWhenSidecarRestartFails(t *testing.T) {
	app := NewApp()
	app.ctx = context.Background()
	app.sidecar = &fakeSidecarProcess{startErr: errors.New("spawn failed")}
	app.dialIPC = func(context.Context, string, string) (ipcClient, error) {
		return nil, errors.New("dial failed")
	}

	got, err := app.EnsureConnected()
	if err != nil {
		t.Fatalf("EnsureConnected() unexpected error: %v", err)
	}
	if got != `{"state":"disconnected"}` {
		t.Fatalf("EnsureConnected() = %s, want disconnected", got)
	}
}

func TestAppEnsureConnectedReportsDisconnectedWhenRedialAfterRestartFails(t *testing.T) {
	app := NewApp()
	app.ctx = context.Background()
	app.sidecar = &fakeSidecarProcess{}
	app.dialIPC = func(context.Context, string, string) (ipcClient, error) {
		return nil, errors.New("dial failed")
	}

	got, err := app.EnsureConnected()
	if err != nil {
		t.Fatalf("EnsureConnected() unexpected error: %v", err)
	}
	if got != `{"state":"disconnected"}` {
		t.Fatalf("EnsureConnected() = %s, want disconnected", got)
	}
}
