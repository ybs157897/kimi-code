//go:build packaged

package appdata

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
)

// expertsArchive is generated at build time by scripts/bundle-experts.mjs
// (tar -czf of the repository's .kimi-desktop/experts tree) and embedded by
// the packaged Wails build.
//
//go:embed experts.tar.gz
var expertsArchive []byte

// MaterializeDefaultExperts seeds the user-level experts root
// (<homeDir>/experts). It is idempotent: an existing target directory is
// never touched, so a user's own experts configuration always wins over the
// bundled defaults.
func MaterializeDefaultExperts(homeDir string) error {
	target := filepath.Join(homeDir, "experts")
	if _, err := os.Stat(target); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("experts: stat %s: %w", target, err)
	}
	if err := os.MkdirAll(homeDir, 0o700); err != nil {
		return fmt.Errorf("experts: mkdir %s: %w", homeDir, err)
	}
	if err := extractExpertsArchive(bytes.NewReader(expertsArchive), homeDir); err != nil {
		return fmt.Errorf("experts: materialize: %w", err)
	}
	return nil
}
