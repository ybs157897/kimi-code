# Kimi Code Desktop

A [Wails v2](https://wails.io) desktop shell around the Kimi Code web UI
(`apps/kimi-web`). The window renders the exact production web bundle, so
features, styling, and behavior match `kimi web` one-to-one.

## How it works

- **UI**: `frontend/dist/` (the built kimi-web bundle, embedded via
  `go:embed`) is served by the Wails asset server.
- **API**: the shell starts a loopback reverse proxy and injects its origin
  into the page as `window.__KIMI_DESKTOP_SERVER_ORIGIN__`. The proxy
  forwards REST (`/api/v1`, `/api/v2`) and the `/api/v1/ws` WebSocket to a
  local kap-server, answers CORS itself, and strips the browser `Origin`
  header upstream (the server treats Origin-less requests as non-browser
  clients — the same trick the Vite dev proxy uses).
- **Server discovery**: `KIMI_SERVER_URL` env → live entries in
  `<kimi home>/server/instances/` → the legacy `server/lock` → a reachable
  default `127.0.0.1:58627`. When nothing is running and `kimi` is on PATH,
  the shell spawns `kimi web --no-open` once and stops it again on quit.
  Discovery re-runs per request, so starting a server later just works.
- **Auth**: the persisted token at `<kimi home>/server.token` is injected as
  `window.__KIMI_DESKTOP_SERVER_TOKEN__` (read once and scrubbed by the web
  bundle). Without it the web UI's own token dialog takes over.

## Prerequisites

- Go ≥ 1.24 and the Xcode Command Line Tools (macOS).
- The repo's pnpm workspace installed (`pnpm install` at the root).
- Optional: the Wails CLI for packaged builds —
  `go install github.com/wailsapp/wails/v2/cmd/wails@latest`.

## Build & run

```sh
# 1. Build the web UI and copy it into frontend/dist
pnpm --filter @moonshot-ai/kimi-desktop build:frontend

# 2a. Run directly
go run -tags desktop,production .

# 2b. Or produce a packaged app (requires the wails CLI)
wails build
```

`wails build` output lands in `build/bin/`. Both `frontend/dist/` and
`build/bin/` are gitignored — step 1 is required after a fresh clone or any
web UI change.
