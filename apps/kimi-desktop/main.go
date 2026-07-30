// Kimi Desktop is a self-contained Wails application around the kimi-web UI.
// The webview talks to the embedded engine helper through Wails bindings and
// authenticated local IPC. It never discovers or spawns `kimi web`, so the
// desktop lifecycle, account state, and data directory stay independent from
// the Kimi Code CLI.
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "Kimi Code",
		Width:     1440,
		Height:    900,
		MinWidth:  960,
		MinHeight: 640,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		Bind:       []any{app},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
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
