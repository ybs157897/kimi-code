//go:build !packaged

package appdata

// MaterializeDefaultExperts is a no-op in development builds: the bundled
// experts archive only exists in packaged builds (see
// bundled_experts_packaged.go).
func MaterializeDefaultExperts(string) error { return nil }
