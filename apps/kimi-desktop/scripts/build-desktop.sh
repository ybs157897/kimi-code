#!/usr/bin/env bash
#
# Build the kimi-desktop application (macOS).
#
# Usage:
#   ./scripts/build-desktop.sh              # full build
#   ./scripts/build-desktop.sh --no-zip      # skip the final ZIP packaging
#
set -euo pipefail

cd "$(dirname "$0")/.."

# ── Go toolchain ────────────────────────────────────────────────────────
# Locate a local Go installation if the system one is not in PATH.
if ! command -v go &>/dev/null; then
  for candidate in \
    "$HOME/.local/go/bin/go" \
    "/usr/local/go/bin/go" \
    "/opt/homebrew/bin/go" \
    ".tmp/go/bin/go" \
  ; do
    if [ -x "$candidate" ]; then
      GOROOT="$(cd "$(dirname "$candidate")/.." && pwd)"
      export GOROOT
      export PATH="$GOROOT/bin:$HOME/go/bin:$PATH"
      break
    fi
  done
fi

if ! command -v go &>/dev/null; then
  echo "ERROR: Go not found. Install Go 1.24+ or place it under .tmp/go/" >&2
  exit 1
fi

go_version="$(go version)"
echo "Using: $go_version"

# ── Wails CLI ───────────────────────────────────────────────────────────
if ! command -v wails &>/dev/null; then
  if [ -x "$HOME/go/bin/wails" ]; then
    export PATH="$HOME/go/bin:$PATH"
  else
    echo "ERROR: wails CLI not found. Install it with:" >&2
    echo "  go install github.com/wailsapp/wails/v2/cmd/wails@latest" >&2
    exit 1
  fi
fi

echo "Using: wails $(wails version 2>&1 | head -1)"

# ── Build steps ─────────────────────────────────────────────────────────
echo ""
echo "==> 1/3: Building frontend (kimi-web)..."
pnpm run build:frontend

echo ""
echo "==> 2/3: Building sidecar (Node SEA engine)..."
pnpm run build:sidecar

echo ""
echo "==> 3/3: Building Go binary + Wails bundle..."
wails build -tags packaged -skipbindings

# ── Post-processing ─────────────────────────────────────────────────────
SKIP_ZIP="${1:-}"
if [ "$SKIP_ZIP" = "--no-zip" ]; then
  echo ""
  echo "Done (--no-zip). App bundle at: build/bin/kimi-desktop.app"
else
  echo ""
  echo "==> Packaging: codesign + ZIP..."
  node scripts/package-macos.mjs
fi

echo ""
echo "✓ Build complete."
ls -lh build/bin/
