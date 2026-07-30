package appdata

import (
	"path/filepath"
	"testing"
)

func TestHomeDirUsesDesktopOverrideOnly(t *testing.T) {
	desktopHome := filepath.Join(t.TempDir(), "desktop-home")
	t.Setenv(HomeEnv, desktopHome)
	t.Setenv("KIMI_CODE_HOME", filepath.Join(t.TempDir(), "cli-home"))

	if got, want := HomeDir(), filepath.Clean(desktopHome); got != want {
		t.Fatalf("HomeDir() = %q, want %q", got, want)
	}
}

func TestHomeDirDefaultsToKimiDesktop(t *testing.T) {
	t.Setenv(HomeEnv, "")
	t.Setenv("KIMI_CODE_HOME", filepath.Join(t.TempDir(), "cli-home"))

	if got := filepath.Base(HomeDir()); got != ".kimi-desktop" {
		t.Fatalf("HomeDir() basename = %q, want .kimi-desktop", got)
	}
}
