//go:build packaged

package sidecar

import (
	_ "embed"
	"runtime"
)

// The build script generates exactly one platform-specific helper before
// invoking `wails build -tags packaged`.
//
//go:embed runtime/kimi-desktop-engine*
var packagedRuntime []byte

func embeddedRuntime() ([]byte, string) {
	name := "kimi-desktop-engine"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return packagedRuntime, name
}
