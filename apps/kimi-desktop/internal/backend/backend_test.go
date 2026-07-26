package backend

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInjectBootstrap(t *testing.T) {
	html := "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>"
	out := injectBootstrap(html, "http://127.0.0.1:9999", `tok"en`)
	if !strings.Contains(out, `window.__KIMI_DESKTOP_SERVER_ORIGIN__="http://127.0.0.1:9999";`) {
		t.Fatalf("missing origin global: %s", out)
	}
	if !strings.Contains(out, `window.__KIMI_DESKTOP_SERVER_TOKEN__="tok\"en";`) {
		t.Fatalf("token not injected as an escaped JS literal: %s", out)
	}
	if !strings.HasPrefix(out, "<!doctype html><html><head><script>") {
		t.Fatalf("script must land right after <head>: %s", out)
	}

	noToken := injectBootstrap(html, "http://127.0.0.1:9999", "")
	if strings.Contains(noToken, "__KIMI_DESKTOP_SERVER_TOKEN__") {
		t.Fatalf("empty token must not be injected: %s", noToken)
	}
}

func TestProxyStripsOriginAndAnswersCors(t *testing.T) {
	var upstreamOrigin string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamOrigin = r.Header.Get("Origin")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer upstream.Close()

	t.Setenv("KIMI_SERVER_URL", upstream.URL)
	proxy, err := StartProxy(NewResolver())
	if err != nil {
		t.Fatalf("StartProxy: %v", err)
	}
	defer proxy.Close()

	req, _ := http.NewRequest(http.MethodGet, proxy.Origin()+"/api/v1/healthz", nil)
	req.Header.Set("Origin", "wails://wails")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("proxied request: %v", err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if string(body) != `{"code":0}` {
		t.Fatalf("unexpected body: %s", body)
	}
	if upstreamOrigin != "" {
		t.Fatalf("Origin must be stripped upstream, got %q", upstreamOrigin)
	}
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "wails://wails" {
		t.Fatalf("CORS origin not reflected, got %q", got)
	}

	pre, _ := http.NewRequest(http.MethodOptions, proxy.Origin()+"/api/v1/sessions", nil)
	pre.Header.Set("Origin", "wails://wails")
	pre.Header.Set("Access-Control-Request-Method", "POST")
	pre.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	preRes, err := http.DefaultClient.Do(pre)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	_ = preRes.Body.Close()
	if preRes.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight status = %d", preRes.StatusCode)
	}
	if got := preRes.Header.Get("Access-Control-Allow-Headers"); got != "authorization,content-type" {
		t.Fatalf("requested headers not reflected, got %q", got)
	}
}

func TestNormalizeHost(t *testing.T) {
	for input, want := range map[string]string{
		"":          "127.0.0.1",
		"0.0.0.0":   "127.0.0.1",
		"::":        "127.0.0.1",
		"[::]":      "127.0.0.1",
		"127.0.0.1": "127.0.0.1",
		"localhost": "localhost",
	} {
		if got := normalizeHost(input); got != want {
			t.Fatalf("normalizeHost(%q) = %q, want %q", input, got, want)
		}
	}
}
