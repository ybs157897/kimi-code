//go:build !packaged

package sidecar

func embeddedRuntime() ([]byte, string) {
	return nil, ""
}
