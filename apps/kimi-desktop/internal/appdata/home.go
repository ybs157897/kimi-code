// Package appdata owns the desktop application's private data root.
package appdata

import (
	"os"
	"path/filepath"
)

const HomeEnv = "KIMI_DESKTOP_HOME"

// HomeDir returns the desktop-only data root. KIMI_CODE_HOME is intentionally
// ignored: sharing that override would couple desktop sessions, credentials,
// and configuration back to the CLI.
func HomeDir() string {
	if fromEnv := os.Getenv(HomeEnv); fromEnv != "" {
		return filepath.Clean(fromEnv)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".kimi-desktop"
	}
	return filepath.Join(home, ".kimi-desktop")
}
