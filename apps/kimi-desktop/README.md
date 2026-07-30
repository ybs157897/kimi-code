# Kimi Code Desktop

A self-contained [Wails v2](https://wails.io) desktop application using the
Kimi Code web UI (`apps/kimi-web`) and the TypeScript agent engine.

## How it works

- **UI**: `frontend/dist/` (the built kimi-web bundle, embedded via
  `go:embed`) is served by the Wails asset server.
- **Engine**: packaged builds embed a Node SEA helper in the application.
  Wails extracts and starts it directly, with no dependency on `kimi`,
  `pnpm`, or a separately running kap-server.
- **API**: the webview calls the engine through Wails bindings and an
  authenticated loopback NDJSON channel. It does not use an HTTP proxy.
- **Process behavior**: the engine helper is launched without a console
  window on Windows and is stopped with the application.
- **Home and auth**: desktop config, sessions, logs, and OAuth credentials
  live under `~/.kimi-desktop` (override with `KIMI_DESKTOP_HOME`). The
  desktop application never reads `KIMI_CODE_HOME` or `~/.kimi-code`.

## Prerequisites

- Node.js ≥ 24.15.0, Go ≥ 1.24, and the platform build toolchain.
- The repo's pnpm workspace installed (`pnpm install` at the root).
- Optional: the Wails CLI for packaged builds —
  `go install github.com/wailsapp/wails/v2/cmd/wails@latest`.

## Build & run

```sh
# Development build (uses the repository sidecar command)
pnpm --filter @moonshot-ai/kimi-desktop dev

# Packaged self-contained application
pnpm --filter @moonshot-ai/kimi-desktop build
```

The packaged build creates the Node SEA helper first and then invokes Wails
with the `packaged` build tag. Generated JavaScript bindings are skipped
because the web app owns a typed manual bridge. Output lands in `build/bin/`.
