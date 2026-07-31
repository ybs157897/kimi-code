/**
 * ACP `AgentSideConnection` wrapper.
 *
 * Production callers provide the runtime-neutral {@link AcpHost}. The
 * {@link KimiHarness} overload is retained only as a public compatibility
 * facade and is converted once through {@link LegacyAcpHost}.
 */

import { randomUUID } from 'node:crypto';

import {
  RequestError,
  type Agent,
  type AgentCapabilities,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientCapabilities,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { log } from '@moonshot-ai/kimi-code-sdk';

import { TERMINAL_AUTH_METHOD, buildTerminalAuthMethod } from './auth-methods';
import { AcpSession, type TelemetryTrackFn } from './session';
import type { IAcpSessionHost } from './iacp-session-host';
import { buildSessionConfigOptionsFromModels } from './config-options';
import { availableCommandsUpdateNotification } from './events-map';
import { acpMcpServersToConfigs } from './mcp';
import { DEFAULT_MODE_ID } from './modes';
import type { AcpHost } from './types';
import { negotiateVersion, type AcpVersionSpec } from './version';
import { effortStringOrUndefined } from './effort';
import { toAcpHost } from './host';
import { sessionSummaryToSessionInfo } from './session-info';
import {
  toResolvedSlashCommands,
  type ResolvedSlashCommands,
  type SlashCommandsResolver,
} from './slash-commands';

/**
 * Agent-side ACP handler backed by an {@link AcpHost}. The host is normalized
 * eagerly so every route uses the same runtime-neutral contract. The
 * {@link AgentSideConnection} (if supplied) is forwarded to every
 * {@link AcpSession} so the session can push `session/update` chunks back to
 * the client.
 */
export class AcpServer implements Agent {
  private negotiated: AcpVersionSpec | undefined;
  private clientCapabilities: ClientCapabilities | undefined;
  private readonly sessions = new Map<string, AcpSession>();
  private readonly agentInfo: Implementation | undefined;
  private readonly terminalAuthEnv: Readonly<Record<string, string>> | undefined;
  private readonly terminalAuthLegacyCommand: string | undefined;
  private readonly resolveSlashCommands: (
    session: IAcpSessionHost,
  ) => Promise<ResolvedSlashCommands>;
  private readonly host: AcpHost;

  constructor(
    host: AcpHost | KimiHarness,
    private readonly conn?: AgentSideConnection | undefined,
    opts?: {
      agentInfo?: Implementation;
      /**
       * Env vars to advertise in `authMethods[0].env` so the `kimi login`
       * subprocess the client spawns (via `terminal-auth`) lands its
       * token under the same data root the ACP server uses. Intended for
       * sandboxed test setups (e.g. `{ KIMI_CODE_HOME: '/tmp/...' }`);
       * leave undefined in production so the advertised env stays empty.
       */
      terminalAuthEnv?: Readonly<Record<string, string>>;
      /**
       * Absolute binary path advertised in `_meta['terminal-auth'].command`
       * for clients that don't yet honor the first-class
       * `AuthMethodTerminal` (Zed without `AcpBetaFeatureFlag`, JetBrains
       * plugin). Clients on this legacy path spawn `<command> login`
       * directly. Defaults to undefined (the `_meta` fallback is omitted).
       */
      terminalAuthLegacyCommand?: string;
      /**
       * Slash commands to advertise in the one-shot
       * `available_commands_update` pushed immediately after each
       * `session/new`, `session/load`, and `session/resume`. Accepts
       * either a static array, or a resolver called once per session
       * (with the just-created session host) so per-session sources like
       * `listSkills()` can be merged in. When omitted, the
       * adapter falls back to an empty list.
       *
       * Returning a {@link SlashCommandsSnapshot} (`{ commands, skillCommandMap }`)
       * additionally lets {@link AcpSession.prompt} intercept
       * `/skill:<name> ...` inputs at the adapter boundary and route
       * them to the session host's skill activation port instead of forwarding the
       * raw slash text — matching the TUI's slash-command behavior so
       * skill activations don't fall back to model-driven Bash
       * exploration of `~/.kimi-code/skills/`.
       */
      slashCommands?: SlashCommandsResolver;
    },
  ) {
    this.host = toAcpHost(host);
    if (this.conn !== undefined) this.host.bindConnection?.(this.conn);
    this.agentInfo = opts?.agentInfo;
    this.terminalAuthEnv = opts?.terminalAuthEnv;
    this.terminalAuthLegacyCommand = opts?.terminalAuthLegacyCommand;
    const slash = opts?.slashCommands;
    this.resolveSlashCommands =
      typeof slash === 'function'
        ? async (session) => toResolvedSlashCommands(await slash(session))
        : async () => toResolvedSlashCommands(slash ?? []);
  }

  /** Returns the {@link AcpVersionSpec} chosen during `initialize`, if any. */
  get negotiatedVersion(): AcpVersionSpec | undefined {
    return this.negotiated;
  }

  /** Returns the client capabilities advertised during `initialize`, if any. */
  get clientCaps(): ClientCapabilities | undefined {
    return this.clientCapabilities;
  }

  /** @internal — for tests/inspection only. */
  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.negotiated = negotiateVersion(params.protocolVersion);
    this.clientCapabilities = params.clientCapabilities;
    this.host.setClientCapabilities?.(this.clientCapabilities);

    const agentCapabilities: AgentCapabilities = {
      loadSession: true,
      promptCapabilities: {
        image: true,
        audio: false,
        embeddedContext: true,
      },
      mcpCapabilities: {
        http: true,
        sse: true,
      },
      sessionCapabilities: {
        list: {},
        resume: {},
      },
    };

    return {
      protocolVersion: this.negotiated.protocolVersion,
      agentCapabilities,
      authMethods: [
        this.terminalAuthEnv !== undefined || this.terminalAuthLegacyCommand !== undefined
          ? buildTerminalAuthMethod({
              env: this.terminalAuthEnv,
              legacyCommand: this.terminalAuthLegacyCommand,
            })
          : TERMINAL_AUTH_METHOD,
      ],
      ...(this.agentInfo ? { agentInfo: this.agentInfo } : {}),
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!(await this.host.checkAuthenticated())) {
      throw RequestError.authRequired();
    }
    // ACP's cwd and MCP servers are explicit fields on the runtime-neutral
    // host contract. The v2 host passes them to hosted lifecycle creation,
    // while the legacy compatibility host performs its own SDK projection.
    const mcpServers = acpMcpServersToConfigs(params.mcpServers);
    if (!this.conn) {
      // Defensive: every code path that constructs `AcpServer` (the
      // runners below, and any test that intends to drive `newSession`)
      // must supply the connection. Surface a clear internal error
      // rather than letting Phase 3.4's `prompt` discover a missing
      // connection mid-stream.
      throw RequestError.internalError(undefined, 'AcpServer is missing its AgentSideConnection');
    }
    // Pre-mint the id so the hosted Workspace FS and engine scope use the
    // same session identity.
    const sessionId = `session_${randomUUID()}`;
    const session = await this.host.createSession({
      sessionId,
      workDir: params.cwd,
      mcpServers,
      mode: 'new',
    });
    const currentModelId = await this.resolveCurrentModelId();
    const currentThinkingEffort = await this.resolveCurrentThinkingEffort(session);
    const acpSession = new AcpSession(
      this.conn,
      session,
      this.clientCapabilities,
      this.makeTelemetryTrack(),
      currentModelId,
      this.host,
      currentThinkingEffort,
    );
    this.sessions.set(session.id, acpSession);
    // Phase 14 (PLAN D11) advertises both the model and mode pickers as
    // a unified `configOptions: SessionConfigOption[]` surface. The
    // dedicated Phase 12 `modes:` field is gone — see
    // `docs/{zh,en}/reference/kimi-acp.md` and the changeset for the
    // pre-release breaking note. `currentModeId` always starts at
    // `default` (PLAN D9); `currentModelId` is resolved from the harness
    // config (`defaultModel` if set, else the first listed alias) so
    // the dropdown's "current" highlight matches the session the SDK
    // just constructed. The `thinking` picker is added when the
    // current model's catalog row advertises `thinkingSupported` — one
    // row per declared effort level (plus `off`), or the legacy
    // `off` / `on` pair for boolean models.
    const configOptions = buildSessionConfigOptionsFromModels(
      await this.host.listAvailableModels(),
      currentModelId,
      currentThinkingEffort,
      DEFAULT_MODE_ID,
    );
    this.scheduleAvailableCommandsUpdate(session.id);
    return {
      sessionId: session.id,
      configOptions,
    };
  }

  /**
   * Handle ACP `session/load`. Mirrors {@link newSession}'s auth gate
   * and connection guard, but resumes an existing on-disk session
   * via the shared {@link setupSessionFromExisting} helper instead of
   * creating a new one. After the AcpSession is wired up, replays the
   * persisted history as a synchronous batch of `session/update`
   * notifications so the client sees the prior turns before the
   * response settles.
   *
   * The ACP `LoadSessionResponse` shape allows an empty body — every
   * field (`configOptions`, `models`, `modes`) is optional. Phase 12.1
   * starts populating `modes` so a resumed session re-renders Zed's
   * mode dropdown identically to a freshly created one; the
   * `currentModeId` is always `default` on load because the SDK does
   * not persist mode across runs (PLAN D9).
   *
   * The non-trivial setup (auth gate, connection guard, harness
   * resume, AcpSession construction, session registration, configOptions
   * computation) is shared with {@link resumeSession} via
   * {@link setupSessionFromExisting}; the ONE differentiator is that
   * `loadSession` calls `replayHistory()` here, whereas `resumeSession`
   * deliberately skips it (per ACP spec G4 / plan gap-4.3).
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const { session, acpSession, configOptions } = await this.setupSessionFromExisting({
      cwd: params.cwd,
      sessionId: params.sessionId,
      mcpServers: params.mcpServers,
      mode: 'load',
    });
    // Synchronously replay history — the response must not settle
    // until every historical `session/update` has been pushed,
    // otherwise the client would race the load completion against
    // its own UI bootstrap. This is the ONE difference vs.
    // `resumeSession`, which intentionally omits this step.
    await acpSession.replayHistory();
    this.scheduleAvailableCommandsUpdate(session.id);
    return { configOptions };
  }

  /**
   * Handle ACP `session/resume`. Per ACP spec, `session/resume` is the
   * lighter-weight sibling of `session/load`: same on-disk session
   * rehydration, same `configOptions:` advertisement — but the client
   * is expected to have already seen the prior turns, so the agent
   * deliberately does NOT replay history. This makes `resumeSession`
   * the right surface for clients that maintain their own transcript
   * (e.g. external session managers, or a TUI reattaching to a still-
   * running session) and would only flicker if the agent re-emitted
   * the historical `session/update` notifications.
   *
   * Setup is shared verbatim with {@link loadSession} via
   * {@link setupSessionFromExisting} (auth gate, conn guard, harness
   * `resumeSession` with `session.not_found` mapping, AcpSession
   * construction, configOptions build). The only differences are:
   * (a) telemetry mode is `'resume'` (vs `'load'`), and (b) no
   * `replayHistory()` call. See plan G4 (lines 106-170) for the
   * rationale, and gap-4.1 for the matching capability advertisement.
   */
  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const { session, configOptions } = await this.setupSessionFromExisting({
      cwd: params.cwd,
      sessionId: params.sessionId,
      mcpServers: params.mcpServers,
      mode: 'resume',
    });
    this.scheduleAvailableCommandsUpdate(session.id);
    return { configOptions };
  }

  /**
   * Shared setup for `session/load` and `session/resume`: gates auth,
   * checks the connection, resolves MCP servers, asks the harness to
   * resume the on-disk session, computes the current model/thinking
   * projection (with a resume-state fallback), constructs the
   * {@link AcpSession}, registers it under `session.id`, and builds
   * the unified `configOptions:` surface (PLAN D11) that both handlers
   * return.
   *
   * Behavior is byte-for-byte identical to the pre-refactor
   * `loadSession` body minus the `replayHistory()` call — which lives
   * in `loadSession` itself because `resumeSession` per ACP spec must
   * NOT replay history (the client is expected to have already seen
   * those turns; replay is a load-only behavior). See plan G4
   * (lines 106-170) for the rationale.
   *
   * The `session.not_found` → `invalidParams` mapping is preserved so
   * unknown-session errors surface as a structured JSON-RPC failure rather
   * than a generic internal error.
   */
  private async setupSessionFromExisting(params: {
    cwd: string;
    sessionId: string;
    mcpServers?: ReadonlyArray<McpServer>;
    mode: 'load' | 'resume';
  }): Promise<{
    session: IAcpSessionHost;
    acpSession: AcpSession;
    configOptions: SessionConfigOption[];
  }> {
    if (!(await this.host.checkAuthenticated())) {
      throw RequestError.authRequired();
    }
    if (!this.conn) {
      throw RequestError.internalError(undefined, 'AcpServer is missing its AgentSideConnection');
    }
    // Forward ACP-supplied MCP servers through the host contract. The
    // persisted session remains authoritative for its workspace root.
    const mcpServers = acpMcpServersToConfigs(params.mcpServers);
    let session: IAcpSessionHost;
    try {
      session = await this.host.resumeSession({
        sessionId: params.sessionId,
        workDir: params.cwd,
        mcpServers,
        mode: params.mode,
      });
    } catch (error) {
      // Surface unknown-session as invalid_params so the JSON-RPC layer
      // returns a structured failure rather than a generic internal
      // error. Other errors propagate as-is.
      const code = (error as { code?: string } | undefined)?.code;
      if (code === 'session.not_found') {
        throw RequestError.invalidParams(
          { sessionId: params.sessionId },
          `Unknown sessionId: ${params.sessionId}`,
        );
      }
      throw error;
    }
    // Phase 14 (PLAN D11) — same `configOptions:` advertisement as
    // `newSession`. `currentModeId` is `default` on every load (mode
    // is session-scoped per PLAN D9); `currentModelId` is read from
    // the resumed session's main-agent config when available so the
    // dropdown's highlight matches the model the resumed turn will
    // actually use — falling back to the harness-level default
    // resolution when the resume state lacks a `modelAlias`.
    const resumeState = await session.getResumeState?.() as
      | {
          readonly agents?: Readonly<Record<string, {
            readonly config?: {
              readonly modelAlias?: string;
              readonly thinkingLevel?: string;
            };
          }>>;
        }
      | undefined;
    const resumedModelAlias = resumeState?.agents?.['main']?.config?.modelAlias;
    const currentModelId =
      typeof resumedModelAlias === 'string' && resumedModelAlias.length > 0
        ? resumedModelAlias
        : await this.resolveCurrentModelId();
    // The resumed thinking effort is read off the main-agent config and
    // carried through as-is — it is the engine-resolved value
    // (`'off'`, `'on'`, or a declared level), which the thinking picker
    // projects onto its row set. Falls back to the live session status,
    // then the harness-level default, when the resume state lacks the
    // field.
    const resumedThinkingEffort = resumeState?.agents?.['main']?.config?.thinkingLevel;
    const currentThinkingEffort = await this.resolveCurrentThinkingEffort(
      session,
      resumedThinkingEffort,
    );
    const acpSession = new AcpSession(
      this.conn,
      session,
      this.clientCapabilities,
      this.makeTelemetryTrack(),
      currentModelId,
      this.host,
      currentThinkingEffort,
    );
    this.sessions.set(session.id, acpSession);
    const configOptions = buildSessionConfigOptionsFromModels(
      await this.host.listAvailableModels(),
      currentModelId,
      currentThinkingEffort,
      DEFAULT_MODE_ID,
    );
    return { session, acpSession, configOptions };
  }

  /**
   * Re-check whether the on-disk token is usable; does NOT trigger an
   * actual OAuth flow. The stdio JSON-RPC channel has no TTY to render
   * the device-code prompt — clients are expected to spawn
   * `kimi login` themselves via the terminal-auth method advertised in
   * `initialize.authMethods` (`args:['login']`, see {@link TERMINAL_AUTH_METHOD})
   * and then re-invoke `authenticate('login')` to confirm the token
   * landed on disk. Mirrors kimi-cli `acp/server.py:374-398` semantics
   * (plan G3, lines 68-104).
   */
  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse | void> {
    if (params.methodId !== 'login') {
      throw RequestError.invalidParams(
        { methodId: params.methodId },
        `Unknown auth method: ${params.methodId}`,
      );
    }
    if (!(await this.host.checkAuthenticated())) {
      throw RequestError.authRequired();
    }
    // void = empty success body (ACP allows AuthenticateResponse | void).
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(undefined, `Unknown sessionId: ${params.sessionId}`);
    }
    return acpSession.prompt(params.prompt);
  }

  async cancel(params: CancelNotification): Promise<void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      // `cancel` is a JSON-RPC notification — the spec forbids notifications
      // returning errors. Log so unknown sessionIds aren't silently absorbed.
      log.warn('acp: cancel for unknown sessionId', { sessionId: params.sessionId });
      return;
    }
    try {
      await acpSession.cancel();
    } catch (error) {
      // Same notification-cannot-error rule: log and swallow.
      log.warn('acp: error while cancelling session', {
        sessionId: params.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle ACP `session/set_mode`. Looks the session up by id and
   * forwards to {@link AcpSession.setMode}. Unknown session ids throw
   * `invalid_params`; unknown modeIds throw `invalid_params` from
   * inside {@link AcpSession.setMode}.
   *
   * The ACP schema models the response as a `_meta`-only object; we
   * return `undefined` (allowed by the `Agent` interface's
   * `SetSessionModeResponse | void` union) so the wire payload is the
   * canonical empty success.
   */
  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    await acpSession.setMode(params.modeId);
  }

  /**
   * Handle the experimental ACP `session/set_model`
   * (`unstable_setSessionModel`). Looks the session up by id and
   * forwards to {@link AcpSession.setModel}. Errors from the SDK
   * (e.g. an unknown model) propagate as-is so the JSON-RPC layer can
   * surface a structured failure.
   */
  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    await acpSession.setModel(params.modelId);
  }

  /**
   * Handle ACP `session/set_config_option` — the spec's generic
   * config-picker dispatch (PLAN D11). Routes by `params.configId`:
   *
   *  - `'model'` → {@link AcpSession.setModel} (same path as
   *    {@link unstable_setSessionModel}).
   *  - `'mode'`  → {@link AcpSession.setMode} (same path as
   *    {@link setSessionMode}).
   *  - `'thinking'` → {@link AcpSession.setThinking} — `'off'`, the
   *    legacy `'on'` alias, or a declared effort level of the current
   *    model.
   *  - anything else → JSON-RPC `invalid_params` (-32602) BEFORE any
   *    SDK call, so the client sees a structured rejection rather
   *    than a half-applied state change.
   *
   * The underlying {@link AcpSession} methods already emit
   * `config_option_update` via {@link AcpSession.emitConfigOptionUpdate}
   * after the SDK call lands, so the response handler does NOT
   * double-emit — it only builds a fresh snapshot from the now-current
   * `currentModelId` + `currentModeId` and returns it on the wire.
   * This funnels all three input paths
   * (`unstable_setSessionModel` / `setSessionMode` / `setSessionConfigOption`)
   * through the same notification channel with identical shape.
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const acpSession = this.sessions.get(params.sessionId);
    if (!acpSession) {
      throw RequestError.invalidParams(
        { sessionId: params.sessionId },
        `Unknown sessionId: ${params.sessionId}`,
      );
    }
    const value = (params as { value: unknown }).value;
    switch (params.configId) {
      case 'model':
        await acpSession.setModel(String(value));
        break;
      case 'mode':
        await acpSession.setMode(String(value));
        break;
      case 'thinking': {
        // The accepted values mirror the picker's advertised rows:
        // `'off'`, the legacy `'on'` alias (mapped to the model's
        // default effort), or one of the current model's declared
        // effort levels (`'low' | 'medium' | …`). AcpSession validates
        // the level against the catalog and rejects unknown values with
        // `invalid_params` BEFORE any SDK call, so a stale or
        // hand-crafted value can never half-apply.
        await acpSession.setThinking(String(value));
        break;
      }
      default:
        throw RequestError.invalidParams(
          { configId: params.configId },
          `Unknown configId: ${params.configId}`,
        );
    }
    return {
      configOptions: buildSessionConfigOptionsFromModels(
        await this.host.listAvailableModels(),
        acpSession.currentModelId,
        acpSession.currentThinkingEffort,
        acpSession.currentModeId,
      ),
    };
  }

  /**
   * Handle ACP `session/list`. Forwards to
   * {@link AcpHost.listSessions} (optionally filtered by `cwd`) and projects
   * each {@link AcpSessionSummary} into an ACP {@link SessionInfo}.
   *
   * No pagination support in this version — `nextCursor` is always
   * `null`. Mirrors the Python reference at `acp/server.py:303-322`
   * where the response is built in a single shot from the host's
   * full snapshot.
   */
  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP `cwd` ↔ SDK `workDir`. The filter is optional; treat
    // `null` (the schema-allowed sentinel for "no filter") the same
    // as `undefined`.
    const cwd = params.cwd ?? undefined;
    const summaries = await this.host.listSessions(
      cwd === undefined ? {} : { workDir: cwd },
    );
    const sessions: SessionInfo[] = summaries.map((summary) =>
      sessionSummaryToSessionInfo(summary),
    );
    return { sessions, nextCursor: null };
  }

  /**
   * Stub the ACP `ext/<method>` extension surface. The interface
   * declares both `extMethod` and `extNotification` as optional, but
   * implementing them explicitly with a structured `MethodNotFound`
   * response gives clients a uniform failure shape (mirrors the
   * `authenticate` pattern at {@link AcpServer.authenticate}) — some
   * clients treat "method absent on the agent" differently from an
   * explicit error reply.
   *
   * Future work (PLAN D9): route slash-command bridge / model-list /
   * mode-list extensions through here once the adapter has access to
   * the kimi-code app's registry. Phase 11 keeps it as a no-op stub.
   */
  async extMethod(
    method: string,
    _params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    throw RequestError.methodNotFound(method);
  }

  /**
   * Stub the ACP extension-notification surface. Symmetric to
   * {@link extMethod}: throwing `MethodNotFound` here surfaces a
   * structured failure on the JSON-RPC channel rather than a silent
   * drop. The ACP SDK currently models notifications as void-returning
   * promises; throwing is the only way to signal "unsupported" back to
   * the connection layer.
   */
  async extNotification(method: string, _params: Record<string, unknown>): Promise<void> {
    throw RequestError.methodNotFound(method);
  }

  /**
   * Compute the `currentValue` for the `model` config option when the
   * caller (either `newSession` or `loadSession`'s fallback path) does
   * not have a more specific signal. Prefers the host's configured
   * `defaultModel`; otherwise falls back to the first listed catalog
   * alias so the dropdown's "current" highlight is always one of the
   * options the client will render. Returns the empty string when the
   * host has no models at all — a degenerate config the UI can still
   * render (an empty dropdown with an empty `currentValue`).
   *
   * Tolerant to partial test hosts whose optional default-model lookup is
   * absent or throws; the catalog fallback remains deterministic.
   *
   * Logged at `warn` when a fallback fires so a dev who forgot to set
   * `default_model = ...` sees a breadcrumb in the agent log.
   */
  private async resolveCurrentModelId(): Promise<string> {
    try {
      const declared = await this.host.getDefaultModelId?.();
      if (typeof declared === 'string' && declared.length > 0) {
        return declared;
      }
      const models = await this.host.listAvailableModels();
      if (models.length === 0) {
        return '';
      }
      return models[0]!.id;
    } catch (error) {
      log.warn('acp: model catalog unavailable during configOptions assembly', {
        error: error instanceof Error ? error.message : String(error),
      });
      return '';
    }
  }

  /**
   * Compute the initial value for the `thinking` picker's current effort
   * from the session's effective effort. A persisted resume-state effort
   * wins; otherwise the live session status is authoritative. The harness
   * config remains a best-effort fallback for partial SDK stubs and
   * status-read failures (`enabled = true` with no effort collapses to
   * the legacy `'on'` alias, which the picker projects onto the model's
   * default level).
   *
   * Tolerant to partial SDK/session stubs for the same reason
   * {@link resolveCurrentModelId} is — adapter-level unit tests routinely
   * omit `getStatus` or `getConfig`. The swallow-and-fallback path keeps the
   * test ergonomics symmetric.
   */
  private async resolveCurrentThinkingEffort(
    session: IAcpSessionHost,
    resumedThinkingEffort?: unknown,
  ): Promise<string> {
    const resumed = effortStringOrUndefined(resumedThinkingEffort);
    if (resumed !== undefined) return resumed;

    if (typeof session.getStatus === 'function') {
      try {
        const current = effortStringOrUndefined((await session.getStatus()).thinkingEffort);
        if (current !== undefined) return current;
      } catch (error) {
        log.warn('acp: session.getStatus threw during thinking effort resolution; falling back', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      return effortStringOrUndefined(await this.host.getDefaultThinkingEffort?.()) ?? 'off';
    } catch (error) {
      log.warn('acp: default thinking effort unavailable; defaulting to off', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 'off';
    }
  }

  /**
   * Build a {@link TelemetryTrackFn} wrapper bound to the underlying
   * harness so the {@link AcpSession} (and its reverse-RPC bridges in
   * Phase 13) can emit PII-free breadcrumbs through the same
   * `harness.track` channel. The wrapper
   * shape is required by the broader `Record<string, unknown>` properties
   * type {@link TelemetryTrackFn} uses — the harness's own `track` is
   * typed against the narrower `TelemetryProperties` (a
   * `Readonly<Record<string, boolean | number | string | undefined | null>>`),
   * and TS won't widen the parameter type implicitly when assigning into
   * a function-valued field. Phase 13's call sites (`session.ts:790,797,820,822,717`)
   * only emit primitive-valued properties so the runtime narrowing is
   * upheld by construction; the cast is purely a compile-time bridge.
   *
   * Returns `undefined` when the harness lacks `.track` (unit-test
   * stubs); {@link AcpSession} treats absence as "silent passthrough"
   * via {@link safeTrack}.
   */
  private makeTelemetryTrack(): TelemetryTrackFn | undefined {
    if (this.host.track === undefined) return undefined;
    return (event, properties) => this.host.track?.(event, properties);
  }

  private scheduleAvailableCommandsUpdate(sessionId: string): void {
    setTimeout(() => {
      void this.emitAvailableCommandsUpdate(sessionId);
    }, 0);
  }

  private async emitAvailableCommandsUpdate(sessionId: string): Promise<void> {
    if (!this.conn) return;
    const acpSession = this.sessions.get(sessionId);
    if (!acpSession) return;
    try {
      const { commands, skillCommandMap } = await this.resolveSlashCommands(
        acpSession.session,
      );
      // Seed the AcpSession's command catalog BEFORE the notification goes
      // out. The resolver call already awaited the (async) `listSkills()`
      // round trip, so the command list and skill map are the same snapshot
      // the client sees in its palette — no race between "/skill:X is
      // advertised" and "the adapter can intercept /skill:X". Intentionally
      // tolerant of older AcpSession builds in adapter-level unit tests.
      if (typeof acpSession.setAvailableCommands === 'function') {
        acpSession.setAvailableCommands(commands, skillCommandMap);
      } else if (typeof acpSession.setSkillCommandMap === 'function') {
        acpSession.setSkillCommandMap(skillCommandMap);
      }
      await this.conn.sessionUpdate(
        availableCommandsUpdateNotification(sessionId, commands),
      );
    } catch (error) {
      log.warn('acp: failed to push available_commands_update', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

}
