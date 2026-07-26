//go:build darwin

package main

// Wails v2's darwin frontend references UTType, which recent macOS SDKs ship
// in the UniformTypeIdentifiers framework without auto-linking it — without
// this extra LDFLAGS entry the final link fails with
// `Undefined symbols: _OBJC_CLASS_$_UTType`.

// #cgo LDFLAGS: -framework UniformTypeIdentifiers
import "C"
