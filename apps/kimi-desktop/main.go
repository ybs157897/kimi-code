// Kimi Code Desktop — a Wails shell around the kimi-web UI.
//
// The window renders the exact production bundle of apps/kimi-web (copied
// into frontend/dist by `pnpm run build:frontend`), so features and styling
// stay identical to `kimi web` by construction. The shell's own job is
// plumbing:
//
//   - It starts a loopback reverse proxy that forwards every request
//     (REST /api/v1 and the /api/v1/ws WebSocket) to a local
//     kap-server, answering CORS itself and stripping the browser Origin
//     header upstream — the server treats Origin-less requests as
//     non-browser clients, the same trick the Vite dev proxy uses.
//   - It discovers the server through KIMI_SERVER_URL, the instance
//     registry (<kimi home>/server/instances), or the legacy lock file,
//     and spawns `kimi web --no-open` once when nothing is running.
//   - It injects the proxy origin and the persisted server token
//     (<kimi home>/server.token) into index.html before the bundle boots
//     (see the window globals read by apps/kimi-web/src/api/config.ts and
//     serverAuth.ts).
//   - It spawns the Node engine sidecar and binds an App object (app.go) to
//     the webview that drives the engine over unix-socket IPC (see
//     docs/plan/desktop-product.md). The loopback proxy above stays intact as
//     a fallback, so the window still boots when the sidecar is unavailable.
package main

import (
	"context"
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"

	"kimi-desktop/internal/backend"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	resolver := backend.NewResolver()
	proxy, err := backend.StartProxy(resolver)
	if err != nil {
		log.Fatalf("kimi-desktop: failed to start the API proxy: %v", err)
	}

	app := NewApp()

	err = wails.Run(&options.App{
		Title:     "Kimi Code",
		Width:     1440,
		Height:    900,
		MinWidth:  960,
		MinHeight: 640,
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: backend.BootstrapMiddleware(assets, proxy.Origin(), resolver),
		},
		Bind: []any{app},
		OnStartup: func(ctx context.Context) {
			// Start the engine sidecar + IPC client (off the critical path),
			// and warm discovery (and the one-shot `kimi web` spawn) for the
			// loopback proxy fallback — the first API call would trigger it
			// anyway, this just warms it up.
			app.startup(ctx)
			go func() { _, _ = resolver.Resolve(ctx) }()
		},
		OnShutdown: func(ctx context.Context) {
			app.shutdown(ctx)
			resolver.StopSpawned()
			proxy.Close()
		},
		Mac: &mac.Options{
			About: &mac.AboutInfo{
				Title:   "Kimi Code",
				Message: "Desktop shell for the Kimi Code web UI.",
			},
		},
	})
	if err != nil {
		log.Fatalf("kimi-desktop: %v", err)
	}
}
