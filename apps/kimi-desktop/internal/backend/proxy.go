package backend

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// Proxy is the loopback API endpoint the webview talks to. It forwards every
// request to the resolved kap-server, answers CORS preflights itself (the
// webview page runs on the Wails asset origin, so all API calls are
// cross-origin), and strips the browser Origin header upstream — kap-server
// treats Origin-less requests as non-browser clients, which also lets the
// /api/v1/ws WebSocket upgrade through (httputil.ReverseProxy passes Upgrade
// requests, including the Sec-WebSocket-Protocol bearer credential, verbatim).
type Proxy struct {
	listener net.Listener
	server   *http.Server
	origin   string
}

// StartProxy binds 127.0.0.1:0 and serves the reverse proxy in the background.
func StartProxy(resolver *Resolver) (*Proxy, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}

	reverse := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			target, err := resolver.Resolve(pr.In.Context())
			if err != nil {
				// Leave the outbound host empty; the transport fails and the
				// ErrorHandler below turns it into a 502 the web UI renders
				// as its disconnected state.
				pr.Out.URL = &url.URL{Scheme: "http", Host: "127.0.0.1:0"}
				return
			}
			pr.SetURL(target)
			pr.Out.Host = target.Host
			// SetURL keeps the inbound headers; drop the browser Origin so
			// the server-side origin check treats us as a non-browser client
			// (same trick as the Vite dev proxy).
			pr.Out.Header.Del("Origin")
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			applyCors(w, r)
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprintf(w, "kimi-desktop: no reachable kimi server (%v). Start one with `kimi web`.", err)
		},
		ModifyResponse: nil,
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			applyCors(w, r)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		applyCors(w, r)
		reverse.ServeHTTP(w, r)
	})

	server := &http.Server{Handler: handler}
	proxy := &Proxy{
		listener: listener,
		server:   server,
		origin:   fmt.Sprintf("http://%s", listener.Addr().String()),
	}
	go func() { _ = server.Serve(listener) }()
	return proxy, nil
}

// Origin is the http://127.0.0.1:<port> base the web bundle should target.
func (p *Proxy) Origin() string { return p.origin }

func (p *Proxy) Close() {
	_ = p.server.Shutdown(context.Background())
}

// applyCors reflects the request origin. The proxy is loopback-only and the
// bearer credential rides in explicit headers (never cookies), so reflecting
// the caller's origin grants nothing beyond what the local user already has.
func applyCors(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", origin)
	h.Set("Vary", "Origin")
	h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
	if requested := r.Header.Get("Access-Control-Request-Headers"); requested != "" {
		h.Set("Access-Control-Allow-Headers", requested)
	}
	h.Set("Access-Control-Expose-Headers", "Content-Disposition")
	h.Set("Access-Control-Max-Age", "600")
}
