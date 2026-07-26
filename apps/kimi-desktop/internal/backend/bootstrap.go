package backend

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
)

// BootstrapMiddleware rewrites index.html on the way out of the asset server,
// injecting the runtime bridge the web bundle reads at boot:
//
//	window.__KIMI_DESKTOP_SERVER_ORIGIN__ — the loopback proxy origin
//	  (apps/kimi-web/src/api/config.ts)
//	window.__KIMI_DESKTOP_SERVER_TOKEN__ — the persisted server token
//	  (apps/kimi-web/src/api/daemon/serverAuth.ts; read once and scrubbed)
//
// The token is re-read per page load so a rotated token only needs an app
// reload, not a rebuild.
func BootstrapMiddleware(assets fs.FS, proxyOrigin string, resolver *Resolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := strings.TrimSuffix(r.URL.Path, "/")
			if path != "" && path != "/index.html" {
				next.ServeHTTP(w, r)
				return
			}
			raw, err := fs.ReadFile(assets, "frontend/dist/index.html")
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			html := injectBootstrap(string(raw), proxyOrigin, ReadServerToken(resolver.HomeDir()))
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write([]byte(html))
		})
	}
}

func injectBootstrap(html, proxyOrigin, token string) string {
	var script strings.Builder
	script.WriteString("<script>")
	fmt.Fprintf(&script, "window.__KIMI_DESKTOP_SERVER_ORIGIN__=%s;", jsString(proxyOrigin))
	if token != "" {
		fmt.Fprintf(&script, "window.__KIMI_DESKTOP_SERVER_TOKEN__=%s;", jsString(token))
	}
	script.WriteString("</script>")

	// Before <head> content so it runs ahead of every bundle script.
	if idx := strings.Index(html, "<head>"); idx >= 0 {
		at := idx + len("<head>")
		return html[:at] + script.String() + html[at:]
	}
	return script.String() + html
}

// jsString renders a JS string literal. JSON string encoding is a strict
// subset of a JS literal, so this is injection-safe for arbitrary content.
func jsString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return `""`
	}
	return string(encoded)
}
