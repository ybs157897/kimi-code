package appdata

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// extractExpertsArchive expands an experts.tar.gz archive (top-level
// `experts/` directory) into destDir. Members are validated before they
// touch the filesystem: each name is path.Clean-ed and must stay under the
// `experts/` prefix — anything else (path traversal, foreign entries) is
// skipped, never written outside the experts tree.
func extractExpertsArchive(r io.Reader, destDir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("experts archive: gzip: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("experts archive: %w", err)
		}

		name := path.Clean(hdr.Name)
		if name != "experts" && !strings.HasPrefix(name, "experts/") {
			continue
		}
		// filepath.Join cleans the result, so a hostile member can never
		// escape destDir.
		target := filepath.Join(destDir, filepath.FromSlash(name))

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("experts archive: mkdir %s: %w", target, err)
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return fmt.Errorf("experts archive: mkdir %s: %w", filepath.Dir(target), err)
			}
			f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
			if err != nil {
				return fmt.Errorf("experts archive: create %s: %w", target, err)
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return fmt.Errorf("experts archive: write %s: %w", target, err)
			}
			if err := f.Close(); err != nil {
				return fmt.Errorf("experts archive: close %s: %w", target, err)
			}
		default:
			// Symlinks, hard links, devices: nothing the bundled experts
			// archive should contain — skip rather than risk a link escape.
			continue
		}
	}
}
