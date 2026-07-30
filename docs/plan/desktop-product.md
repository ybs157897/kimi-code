# Desktop Product — Architecture & Module Plan

Status: Phase 0 (seam proof). Desktop-first; web retirement and kap-server
fate are explicitly deferred until the desktop is stable.

## 1. Goal & target shape

Make the desktop the product itself (not a wrapper around the web UI), in the
Reasonix model: a native Wails shell whose webview talks to the engine through
a **direct binding** (Go methods in, typed events out) instead of an HTTP hop.

The one hard constraint that differs from Reasonix: our kernel is
TypeScript/Node (`@moonshot-ai/agent-core-v2`), not Go. So "no HTTP hop" is
realized as **no HTTP-semantics hop, with one IPC hop** to a Node engine-host
process. The shell never speaks HTTP to the engine.

```
┌──────────────────────────────────────────────────────────────┐
│ webview: apps/kimi-web (Vue) — UI stays web tech              │
│   bridge layer: window.go.main.App.*  +  runtime.EventsOn      │
│   (plain browser → dev mock through the same event contract)   │
└──────────────▲───────────────────────────────┬───────────────┘
        Wails Bind methods              runtime.EventsEmit("kimi:event")
┌──────────────┴───────────────────────────────▼───────────────┐
│ Go/Wails shell (apps/kimi-desktop)                            │
│   app.go  : App bound surface (forwards to IPC client)        │
│   ipcclient: unix-socket NDJSON klient-ipc client             │
│   spawn   : start/reap the Node sidecar                       │
└──────────────▲───────────────────────────────▼───────────────┐
        unix socket IPC (NDJSON, klient-ipc frame protocol)
┌──────────────┴───────────────────────────────────────────────┐
│ Node engine host / sidecar (apps/kimi-desktop/sidecar)        │
│   bootstrap() → app scope → serveKlientIpc({ scope, … })      │
│   (exposes the whole klient facade over IPC, no new facade)   │
└───────────────────────────────────────────────────────────────┘
```

## 2. Key fact that bounds the work

`serveKlientIpc({ scope })` (packages/klient/src/transports/ipc/host.ts:50)
internally builds `createMemoryDispatcher(scope)`, which reflects **every**
scoped service. So the sidecar exposes the full klient facade (153 methods,
52 event registrations) over IPC with essentially no glue code:

```ts
const { app } = bootstrap({ homeDir, configPath, … }, [ …seeds ]);
await serveKlientIpc({ scope: app, socketPath, token });
```

Therefore:

- **Phase 0** drives the engine through the **klient facade directly** over
  IPC. No product projection layer is built yet.
- The "product layer" that maps klient ↔ the kimi-web product wire
  (the 80-method `KimiWebApi` surface, the 33 domain events) is **Phase 1**.
  It can later live in the sidecar or be absorbed by the frontend; this doc
  does not design it yet.

## 3. Modules — responsibilities & boundaries

Four modules, each with a single owner and non-overlapping file ownership so
they can be built in parallel.

### M1 — Node sidecar (engine host)
- Path: `apps/kimi-desktop/sidecar/**` (part of the existing
  `apps/kimi-desktop` workspace member; add deps + a run script to its
  `package.json`). NOT a new workspace package (avoids the
  pnpm-workspace.yaml + flake.nix sync rule).
- Responsibility: boot the engine (`bootstrap`), serve the klient facade over
  IPC (`serveKlientIpc`), own engine + socket lifecycle. Readiness log line.
- Boundary: knows nothing about Wails/Go. Speaks only the klient-ipc protocol.
- Reference to mirror: `packages/node-sdk/src/v2/runtime.ts` (bootstrap usage
  at :140, `createKlient({ scope: app })` at :262) — use the same `bootstrap`
  import and seeds, but call `serveKlientIpc({ scope: app, … })` instead of
  `createKlient`.
- Owns: `apps/kimi-desktop/sidecar/**`, `apps/kimi-desktop/package.json`
  (deps + `sidecar` script). No other files.

### M2 — Go IPC client
- Path: `apps/kimi-desktop/internal/ipcclient/**` (new Go package).
- Responsibility: a Go client for the klient-ipc frame protocol — dial the
  unix socket, NDJSON encode/decode, handshake, `Call`, `Listen`/`Unlisten`,
  `Stream`, request/response correlation by `id`.
- Boundary: pure protocol client. No Wails, no engine knowledge. Exposes the
  frozen interface in §5 so M3 compiles against it.
- Reference to mirror: `packages/klient/src/transports/ipc/channel.ts` (the TS
  reference client) and `codec.ts` (frame schema).
- Owns: `apps/kimi-desktop/internal/ipcclient/**`. No other files.

### M3 — Go Bind facade + shell wiring
- Path: `apps/kimi-desktop/app.go` (new), `apps/kimi-desktop/main.go` (edit),
  spawn helper under `apps/kimi-desktop/internal/backend/` or a new
  `internal/sidecar/` (new).
- Responsibility: the Wails-bound `App` object; spawn + reap the sidecar;
  connect the M2 IPC client on startup; expose Phase 0 bind methods (§6) that
  forward to the client; subscribe to agent events and re-emit them via
  `runtime.EventsEmit("kimi:event", …)`.
- Boundary: consumes M2's frozen interface; does not implement the protocol.
  Does not edit `package.json` (M1 owns it) — the sidecar launch command is
  taken from the frozen spawn contract (§7).
- Owns: `apps/kimi-desktop/app.go`, `main.go`, `internal/sidecar/**` (or new
  spawn files). Does NOT touch `internal/ipcclient/**` (M2) or `sidecar/**`/
  `package.json` (M1).

### M4 — Frontend bridge + dev mock
- Path: `apps/kimi-web/src/api/desktop/**` (new) + one minimal demo surface.
- Responsibility: a Reasonix-style bridge — detect `window.go.main.App` +
  `window.runtime`; if present, call the bind methods (§6) and subscribe
  `EventsOn("kimi:event")`; if absent (plain browser `pnpm dev`), fall back to
  a dev mock that streams a canned turn through the **same** event contract.
- Boundary: Phase 0 does NOT modify the existing `src/api/daemon/**` data
  layer (avoid risk/conflict). The bridge is additive and isolated, exercised
  by a small demo component/route. The full `KimiWebApi` transport swap is
  Phase 1.
- Owns: `apps/kimi-web/src/api/desktop/**` + the minimal demo files it adds.
  Does NOT touch `src/api/daemon/**`.

## 4. Frozen contract A — IPC frame protocol (M1 ↔ M2)

NDJSON over a unix domain socket: one `JSON.stringify(frame) + "\n"` per
message; decoder splits on `\n`, drops malformed lines. One socket multiplexes
calls, listens, and streams. Authoritative schema:
`packages/klient/src/transports/ipc/codec.ts`.

```ts
interface IpcFrame {
  type: string;        // discriminator
  id?: string;         // request/correlation id
  scope?: string;      // "core" | "session" | "agent" (derived from ids)
  service?: string;
  method?: string;
  arg?: unknown;       // positional args array (trailing undefined trimmed)
  sessionId?: string;
  agentId?: string;
  event?: string;      // listen: emitter event or stream name
  token?: string;      // hello
  code?: number;       // error
  msg?: string;        // error
  data?: unknown;      // result / event payload / stream chunk
}
```

Client → host frames: `hello{token?}`, `call{id,scope,service,method,arg,…}`,
`listen{id,scope,sessionId?,agentId?,event,…}`, `unlisten{id}`,
`stream{id,scope,service,method,arg,…}`, `stream_cancel{id}`.

Host → client frames: `ready{}` (sent first by host), `result{id,data}`,
`error{id,code,msg}`, `listen_result{id}`, `event{id,data}`,
`stream_data{id,data}`, `stream_end{id}`, `stream_error{id,code,msg}`.

Handshake: host sends `ready` on connect; client replies `hello{token}`.
If the host has a token and it mismatches, host sends
`error{id:"hello",code:40100}` and closes. Frames before hello →
`error{code:40001}`. Scope derivation: agentId present → `agent`; else
sessionId present → `session`; else `core`.

Streaming: `stream` → N×`stream_data{id,data}` → `stream_end{id}` (or
`stream_error`). `stream_cancel{id}` aborts (no end/error after abort). No
backpressure, no chunk seq, no resume — on disconnect, reject in-flight calls.

Agent events subscription (used by M3): a `listen` frame with
`scope:"agent"`, `sessionId`, `agentId`, and `event:"events"` (the single
agent event stream; the 40 agent event types are discriminated by the payload's
`type` field). Confirm the exact stream name against
`packages/klient/src/contract/agent/events.ts` and the reference client
`channel.ts`.

## 5. Frozen contract B — Go IPC client interface (M2 implements, M3 consumes)

Package `kimi-desktop/internal/ipcclient`. Phase 0 interface (M2 may add
unexported helpers freely, but these exported signatures are fixed):

```go
package ipcclient

type Scope struct {
    SessionID string // "" => core/session scope
    AgentID   string // non-empty => agent scope
}

// Event is one pushed event for a subscription.
type Event struct {
    ID   string          // subscription id
    Data json.RawMessage // event payload (klient event object)
}

type Client struct { /* … */ }

// Dial connects to the unix socket and completes the hello handshake.
func Dial(ctx context.Context, socketPath, token string) (*Client, error)

// Call invokes a klient procedure and returns its raw JSON result.
func (c *Client) Call(ctx context.Context, s Scope, service, method string, arg []any) (json.RawMessage, error)

// Listen subscribes to an event stream; events are delivered to the channel.
// For agent events use Scope{SessionID,AgentID} + event "events".
func (c *Client) Listen(ctx context.Context, s Scope, event string) (<-chan Event, error)

func (c *Client) Unlisten(id string) error

func (c *Client) Close() error
```

Business payloads stay `json.RawMessage` in Phase 0 (thin passthrough); strong
typing is deferred. M3 must be able to compile against this interface even
before M2 is fully done — implement to the signature.

## 6. Frozen contract C — Wails Bind surface & event channel (M3 ↔ M4)

Bound object `App` (registered via `Bind: []any{app}` in `main.go`). Phase 0
methods (return JSON strings to keep the Go side thin; M4 parses in TS):

```go
func (a *App) Hello() (string, error)                       // sidecar/IPC health
func (a *App) ListSessions() (string, error)                // klient global sessions.list
func (a *App) CreateSession() (string, error)               // returns {sessionId,…}
func (a *App) Submit(sessionId, agentId, text string) error // klient agent prompt
func (a *App) Cancel(sessionId, agentId string) error
```

Event channel: `runtime.EventsEmit("kimi:event", payload)` where payload is a
JSON object `{ "sessionId": …, "agentId": …, "event": <klient agent event> }`.
M4 discriminates on `payload.event.type`.

M4 bridge access pattern (Reasonix-style): resolve bindings lazily via
`window.go?.main?.App`; subscribe via `window.runtime.EventsOn("kimi:event")`.
When these globals are absent (plain browser), use the dev mock that emits the
same `{sessionId,agentId,event}` shape.

## 7. Frozen contract D — sidecar spawn (M1 provides, M3 invokes)

- Socket path: `<kimiHome>/desktop/sidecar.sock` where kimiHome is
  `KIMI_CODE_HOME` or `~/.kimi-code` (mirror `internal/backend/discovery.go`
  `KimiHomeDir()`).
- Token: M3 generates a random hex token at startup, passes it to the sidecar
  via env `KIMI_DESKTOP_IPC_TOKEN`; M3's client uses the same token in hello.
  Socket path passed via env `KIMI_DESKTOP_IPC_SOCKET`.
- Launch (dev): M1 documents a run command, default
  `pnpm --filter @moonshot-ai/kimi-desktop run sidecar` (run from repo root).
  The package script wraps tsx with the decorator-aware tsconfig and the `?raw`
  text loader the engine needs; a bare `tsx sidecar/main.ts` does not run from
  source. M3
  spawns it (reuse the spawn-and-reap pattern from
  `internal/backend/discovery.go`: keep the child attached, SIGTERM on
  shutdown). The command is configurable so a packaged build can swap in a
  bundled node entry later.
- M1 logs a stable readiness line (e.g. `desktop-sidecar ready <socketPath>`)
  so M3 can wait for readiness before dialing.

## 8. Phase 0 acceptance

End-to-end, in the Wails app (and the browser via the mock):
1. Shell starts, spawns the sidecar, IPC client connects + handshakes.
2. `Hello()` returns a healthy status.
3. `CreateSession()` returns a session; `ListSessions()` shows it.
4. `Submit(...)` drives a turn; agent events flow back over `kimi:event` and
   the demo UI renders streamed text / a tool call.
5. `Cancel(...)` aborts an in-flight turn.
The browser dev mock reproduces step 4–5 rendering without the Go side.

## 9. Build & verify per module

- M1: `pnpm install`; run the sidecar script; verify the socket appears and a
  manual klient-ipc client can `call`. TypeScript must typecheck.
- M2: `cd apps/kimi-desktop && go vet ./internal/ipcclient && go test ./internal/ipcclient`
  (add a unit test against an in-process fake or the real sidecar).
- M3: `cd apps/kimi-desktop && go vet ./... `; `wails dev` smoke (or `go run`
  where possible). Depends on M1 + M2.
- M4: `pnpm --filter @moonshot-ai/kimi-web typecheck` (and `pnpm dev` for the
  mock path).
- Integration (parent agent): wire M1–M4, run `wails dev`, exercise §8.

## 10. Out of scope for Phase 0 (deferred)

- Product projection layer (klient ↔ kimi-web product wire), full 80-method
  `KimiWebApi` transport swap, modifying `src/api/daemon/**`. (Phase 1)
- kap-server retirement / other consumers (kimi-inspect, e2e, TUI, ACP).
- Packaging, signing, auto-update.
- Strong typing of business payloads in Go.

## 11. Phase 1 — product projection layer (full web parity)

### 11.1 Goal & decision
- Goal: the desktop speaks the kimi-web **product wire** directly (no kap-server
  HTTP), reusing kimi-web's UI and its existing wire→AppEvent pipeline
  unchanged. This is the B2′ path: build a fresh product layer that is
  wire-compatible with kimi-web; kap-server stays untouched and is retired
  later (deferred until the desktop is stable).
- Wire-contract owner = kimi-web's existing `src/api/daemon/wire.ts`
  (`WireEvent` + snake_case wire types) and `src/api/types.ts` (`KimiWebApi`
  80 methods, `AppEvent` 35). These files ARE the spec; the product layer
  reproduces their shapes exactly so kimi-web's mappers / projector /
  eventReducer (~4200 LOC) reuse unchanged.
- Where it lives: the product layer lives in the **Node sidecar**
  (Reasonix-faithful: the product Controller sits with the kernel). The Go
  shell stays a thin forwarder; kimi-web keeps its wire→AppEvent pipeline.

### 11.2 Serving product over IPC (mechanism)
`serveKlientIpc` reflects only engine services and has no extension hook, so
the sidecar runs a small custom IPC host that:
- reuses the klient-ipc framing (`codec.ts`: `encodeFrame` / `NdjsonDecoder`)
  and `createMemoryDispatcher(scope)` (from `@moonshot-ai/klient`) for every
  existing klient service, so the Phase 0 raw-klient surface keeps working;
- intercepts one reserved service name `desktopProduct` and handles it with the
  product facade instead of the engine dispatcher.
The product facade fulfills methods via an in-process klient
(`createKlient({ scope: app })` from `@moonshot-ai/klient/memory`,
zod-validated) and projects klient agent events → kimi-web `WireEvent`
(mirroring `agentEventProjector.ts` + `wire.ts`). Keep this mechanism isolated
to the sidecar; do NOT modify `packages/klient`.

### 11.3 Frozen contract E — product IPC surface (S1 implements, S2 forwards, S3 consumes)
- Service name: `desktopProduct` (reserved; the sidecar intercepts it).
- Methods: named after `KimiWebApi` methods (camelCase). First-slice subset:
  `listSessions`, `createSession`, `submitPrompt`, `abortPrompt`,
  `respondApproval`, `respondQuestion`.
- Call shape: a klient-ipc `call` frame with `service:"desktopProduct"`,
  `method:<name>`, `arg:<positional array matching the kimi-web request wire>`,
  optional `sessionId`/`agentId`. The result is the kimi-web response wire JSON
  (the same JSON kap-server returns for that endpoint).
- Product events: a `listen` frame with `event:"product"` and
  `sessionId`/`agentId` scope subscribes to the projected product stream; each
  pushed `event` frame's `data` is one kimi-web `WireEvent` (matching
  `wire.ts`). The sidecar projects the klient agent event union → `WireEvent`
  with the same mapping as `agentEventProjector.ts` / `wire.ts`.
- Exact wire shapes are NOT re-specified here. Implementers read
  `apps/kimi-web/src/api/daemon/wire.ts`, `types.ts`, `mappers.ts`,
  `agentEventProjector.ts` as the authoritative spec and match field-for-field.

### 11.4 Frozen contract F — Go product forwarding (S2 implements, S3 consumes)
Add to the bound `App` (keep the Phase 0 methods):

```go
// ProductCall forwards a desktopProduct method; argsJSON / result are kimi-web wire JSON.
func (a *App) ProductCall(method, argsJSON string) (string, error)
// ProductSubscribe subscribes the session/agent product stream; events are
// re-emitted on "kimi:event" as { sessionId, agentId, event: <WireEvent> }.
func (a *App) ProductSubscribe(sessionId, agentId string) error
```

The Go side stays a thin `json.RawMessage` passthrough (no product typing).
`kimi:event` now carries a kimi-web `WireEvent` in `event` (Phase 0 carried a
raw klient event; S3 keys on the `WireEvent.type` field per `wire.ts`).

### 11.5 First vertical slice — modules (3 subagents, non-overlapping)
- **S1 — Sidecar product layer.** Owns `apps/kimi-desktop/sidecar/**`. Build the
  custom IPC host (framing + `createMemoryDispatcher` fallthrough +
  `desktopProduct` interception), the product facade (first-slice methods via an
  in-process klient), and the event projector (klient agent events →
  `WireEvent`). Keep Phase 0 raw-klient serving intact.
- **S2 — Go product forwarding.** Owns `apps/kimi-desktop/app.go` (+ a small
  product helper if needed). Add `ProductCall` / `ProductSubscribe` per
  contract F, forwarding over the existing `internal/ipcclient` (service
  `desktopProduct`, listen event `product`), re-emitting `WireEvent`s on
  `kimi:event`. Do NOT touch `sidecar/**` or `internal/ipcclient/**`.
- **S3 — kimi-web transport (chat subset).** Owns `apps/kimi-web/src/api/desktop/**`
  (+ a flagged construction switch in `api/index.ts`). Build a `WailsKimiWebApi`
  implementing the first-slice `KimiWebApi` methods over the bridge
  (`ProductCall` / `ProductSubscribe`), feeding the EXISTING event pipeline
  (mappers / eventReducer) via `WireEvent`. Gate behind a flag (e.g.
  `?desktop_transport=1`) so default behavior is unchanged; do NOT rewrite
  `src/api/daemon/**` — reuse it.

### 11.6 First-slice acceptance
In the desktop (or browser mock): create a session → submit a prompt → the REAL
kimi-web transcript UI (not the Phase 0 demo) renders streamed assistant text +
a tool card via `WireEvent`s → an approval/question prompt renders and can be
responded → abort works. With no provider configured the seam still proves out
(events flow; the turn ends in a rendered error state).

### 11.7 Out of scope for slice 1 (later Phase 1 slices)
- The other ~74 `KimiWebApi` methods (fs/git, models/providers CRUD, skills,
  expert teams, terminals, oauth, export, config, workspace, tasks…).
- Full 33-event coverage beyond the chat-loop events.
- The 3 transport leaks at scale (bare file URLs, Blob up/download, terminal
  stream) — handled when those features are sliced.
- Removing the loopback proxy / kap-server retirement.

## 12. Phase 1 slice 2 — clean boot methods

### 12.1 Goal
Make `?desktop_transport=1` boot cleanly: no "not yet supported" throw, no
error toast, and the session list + workspace + first session's conversation
render. All boot methods are read-only.

### 12.2 Critical mechanism (drives the hard-blocker set)
`createWailsKimiWebApi` wraps the instance in a `Proxy` that returns a
**synchronously throwing** function for any `KimiWebApi` member not on the class
(`apps/kimi-web/src/api/desktop/client.ts`). A synchronous throw defeats the
many defensive `.catch(() => fallback)` calls in the boot path. Therefore a
missing method either (a) hard-blocks boot (throw lands inside `load()`'s try
or rejects a `Promise.all`) or (b) silently degrades (call is wrapped in an
async try/catch). The hard blockers must be implemented for any boot at all.

### 12.3 Frozen method set (8 new; `listSessions` already exists)
| Method | Wire response (kimi-web `wire.ts`) | kap-server source | Note |
|---|---|---|---|
| `getAuth` | `WireAuthResult` `{ready; providers_count; default_model; managed_provider}` | `routes/auth.ts` (`IAuthLegacyService.get()` projection) | HARD BLOCKER (else `waitForFirstAuth` polls forever) |
| `getHealth` | `{ok:true}` (daemon defaults `uptimeSec=0`) | `registerApiV1Routes.ts` healthz (static) | HARD BLOCKER (first thing that aborts `load()`) |
| `getMeta` | `WireMeta` `{server_version; server_id; started_at; capabilities; open_in_apps; dangerous_bypass_auth; backend:'v2'}` | `routes/meta.ts` (static) | HARD BLOCKER (rejects the boot `Promise.all`) |
| `getConfig` | `WireConfig` (snake_case, secrets redacted) | `routes/config.ts` (`IConfigService.getAll()`) | degrades silently, but implement for clean boot |
| `listWorkspaces` | `WirePage<WireWorkspace>` | `routes/workspaces.ts` (`IWorkspaceService.list()` + session_count) | degrades, implement for correct workspace list |
| `getFsHome` | `WireFsHomeResult` `{home; recent_roots}` | `routes/workspaceFs.ts` (`IHostFileSystem`) | optional, implement (cheap) |
| `listModels` | `{items: WireModel[]}` | `routes/modelCatalog.ts` (`loadCatalog(core).listModels()`) | missing → startup error toast |
| `getSessionSnapshot` | `WireSessionSnapshot` `{as_of_seq; epoch; session; messages; in_flight_turn; subagents?; pending_approvals; pending_questions}` | `routes/snapshot.ts` (`ISnapshotReader`) | needed to render the auto-selected session AND it is the prerequisite for `connectEvents` |

`getMeta`/`getHealth` may be returned statically from the facade (matching
kap-server). All responses are wrapped in the full `WireEnvelope`
(`okEnvelope`, `code:0`); S3 unwraps via the existing `call()` helper.

### 12.4 Modules (2 subagents; S2 needs NO change — `ProductCall` is generic)
- **S1 — sidecar facade.** Owns `apps/kimi-desktop/sidecar/product/**`. Add the
  8 methods to `ProductFacade`, each returning the kap-server-compatible
  `WireEnvelope` JSON. Fulfill via the in-process klient / engine services per
  the source table (mirror the kap-server route logic + `mappers`/`builders`);
  `getMeta`/`getHealth` static. Args: no-arg methods take `[]`;
  `getSessionSnapshot` takes `[sessionId]`.
- **S3 — frontend.** Owns `apps/kimi-web/src/api/desktop/**`. Add the 8 methods
  to `WailsKimiWebApi` (each `this.call<T>(method, args)` + reuse/extend the
  daemon `mappers.ts` wire→App mappings — add `toAppWorkspace`/`toAppModel`/
  `toAppConfig`/`toAppAuth`/snapshot mapping as needed, mirroring
  `daemon/client.ts`). Adding a real method to the class automatically bypasses
  the Proxy's "not yet supported". Extend `mock.ts` with canned wire responses
  so the browser dev path boots too. `connectEvents` is already implemented.

### 12.5 Acceptance
`?desktop_transport=1` boots to the main UI with no "not yet supported" and no
error toast: session list + workspace render, and (when a session exists) its
conversation renders from the snapshot and `connectEvents` establishes. The
browser dev mock reproduces the same boot without the Go side. Read-only boot
methods should also work against the real sidecar (no provider needed for boot).

### 12.6 Out of scope for slice 2 (later slices)
- Per-session sidecars: `getSessionStatus` / `getSessionGoal` /
  `getSessionWarnings` / `listSkills` / `listTasks` / `getGitStatus` /
  `listExtensionCommands`(v2) / `listExpertTeams`+`getExpertTeam`(v2).
- `listProviders`, OAuth flow, all write methods, terminal methods.
