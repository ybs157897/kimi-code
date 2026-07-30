import {
  KimiAuthFacade,
  resolveConfigPath,
  resolveKimiHome,
} from "@moonshot-ai/kimi-code-sdk";
import {
  createKimiDefaultHeaders,
  createKimiDeviceId,
  KIMI_CODE_PROVIDER_NAME,
} from "@moonshot-ai/kimi-code-oauth";
import { createKimiV2Runtime } from "@moonshot-ai/kimi-code-sdk/v2";

import type { RuntimeBroadcast } from "./session-runtime";
import {
  corePermissionForLegacyApproval,
  legacyApprovalMetadata,
  readLegacyApprovalFlags,
  readMigratedLegacyApprovalFlags,
  withGlobalYoloMode,
  type LegacyApprovalFlags,
} from "./legacy-approval";
import { SessionRuntime } from "./session-runtime";
import {
  VscodeV2Host,
  type VscodeHostPort,
  type VscodeSessionHostPort,
  type VscodeSessionPort,
  type VscodeSessionSummary,
} from "./v2-host";
import { areSameFsPath } from "../utils/fs-path";

export interface KimiRuntimeOptions {
  readonly version: string;
  readonly broadcast: RuntimeBroadcast;
  readonly captureBaseline: (
    session: Pick<VscodeSessionSummary, "id" | "workDir" | "metadata">,
    filePath: string,
    webviewIds: readonly string[],
  ) => void;
  readonly log: (message: string, error?: unknown) => void;
  readonly homeDir?: string;
  /** Compatibility injection used by the legacy Node-SDK fixture tests only. */
  readonly harness?: VscodeSessionHostPort;
  readonly host?: VscodeHostPort;
}

export interface OpenSessionOptions {
  readonly webviewId: string;
  readonly workDir: string;
  readonly sessionId?: string;
  readonly model: string;
  readonly effort: string;
  readonly yoloMode: boolean;
}

/** Extension-host owner for one in-process v2 runtime. */
export class KimiRuntime {
  readonly homeDir: string;
  readonly host: VscodeHostPort | undefined;

  private readonly sessionHost: VscodeSessionHostPort;
  private readonly broadcast: RuntimeBroadcast;
  private readonly captureBaseline: KimiRuntimeOptions["captureBaseline"];
  private readonly log: KimiRuntimeOptions["log"];
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly sessionByView = new Map<string, string>();
  private closed = false;

  constructor(options: KimiRuntimeOptions) {
    this.broadcast = options.broadcast;
    this.captureBaseline = options.captureBaseline;
    this.log = options.log;
    this.homeDir = resolveKimiHome(options.homeDir);
    if (options.harness !== undefined) {
      this.sessionHost = options.harness;
      this.host = options.host;
      return;
    }
    const configPath = resolveConfigPath({ homeDir: this.homeDir });
    const identity = {
      userAgentProduct: "kimi-code-vscode",
      version: options.version,
    };
    const auth = new KimiAuthFacade({ homeDir: this.homeDir, configPath, identity });
    this.host =
      options.host ??
      new VscodeV2Host(createKimiV2Runtime({
        homeDir: this.homeDir,
        configPath,
        clientVersion: options.version,
        requestHeaders: createKimiDefaultHeaders({ homeDir: this.homeDir, ...identity }),
        telemetry: {
          enabled: true,
          deviceId: createKimiDeviceId(this.homeDir),
          appName: "kimi-code-vscode",
          uiMode: "vscode",
          getAccessToken: async () =>
            (await auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
        },
      }), this.homeDir);
    this.sessionHost = this.host;
  }

  requireHost(): VscodeHostPort {
    if (this.host === undefined) throw new Error("The v2 host is unavailable in this fixture.");
    return this.host;
  }

  /** Legacy integration-fixture alias; production bridge code uses {@link requireHost}. */
  get harness(): VscodeHostPort {
    return this.host ?? this.sessionHost as VscodeHostPort;
  }

  getSessionForView(webviewId: string): SessionRuntime | undefined {
    const id = this.sessionByView.get(webviewId);
    return id === undefined ? undefined : this.sessions.get(id);
  }

  getSession(id: string): SessionRuntime | undefined {
    return this.sessions.get(id);
  }

  async openSession(options: OpenSessionOptions): Promise<SessionRuntime> {
    this.ensureOpen();
    const current = this.getSessionForView(options.webviewId);
    const requestedId = options.sessionId ?? current?.id;

    if (
      current !== undefined &&
      requestedId === current.id &&
      areSameFsPath(current.session.workDir, options.workDir)
    ) {
      await applySessionSettings(current.session, options, current.legacyApprovalFlags);
      await current.announceStatus(options.webviewId);
      return current;
    }

    let runtime = requestedId === undefined ? undefined : this.sessions.get(requestedId);
    if (runtime !== undefined) {
      assertSessionWorkDir(runtime.session, options.workDir);
      await applySessionSettings(runtime.session, options, runtime.legacyApprovalFlags);
      await this.detachView(options.webviewId);
    } else {
      const defaultApproval: LegacyApprovalFlags = { yolo: options.yoloMode, afk: false };
      const session =
        requestedId === undefined
          ? await this.sessionHost.createSession({
              workDir: options.workDir,
              model: options.model || undefined,
              thinking: normalizeEffort(options.effort),
              permission: corePermissionForLegacyApproval(defaultApproval),
              metadata: legacyApprovalMetadata(defaultApproval),
            })
          : await this.sessionHost.resumeSession({ id: requestedId });
      try {
        assertSessionWorkDir(session, options.workDir);
        const storedApproval = readLegacyApprovalFlags(session.summary?.metadata);
        const restoredApproval =
          storedApproval ?? (await this.readMigratedLegacyApproval(session)) ?? defaultApproval;
        const approval = withGlobalYoloMode(restoredApproval, options.yoloMode);
        if (storedApproval === undefined || flagsDiffer(storedApproval, approval)) {
          await session.updateMetadata(legacyApprovalMetadata(approval));
        }
        await applySessionSettings(session, options, approval);
        await this.detachView(options.webviewId);
        runtime = this.wrapSession(session, approval);
      } catch (error) {
        await session.close().catch((closeError: unknown) => {
          this.log("Failed to close a rejected session", closeError);
        });
        throw error;
      }
    }

    runtime.subscribe(options.webviewId);
    this.sessionByView.set(options.webviewId, runtime.id);
    await runtime.announceStatus(options.webviewId);
    return runtime;
  }

  async attachResumedSession(
    webviewId: string,
    session: VscodeSessionPort,
    defaultYoloMode = false,
  ): Promise<SessionRuntime> {
    const existing = this.sessions.get(session.id);
    if (existing !== undefined && this.sessionByView.get(webviewId) === session.id) {
      existing.subscribe(webviewId);
      await existing.announceStatus(webviewId);
      return existing;
    }
    await this.detachView(webviewId);
    let runtime = existing ?? this.sessions.get(session.id);
    if (runtime === undefined) {
      try {
        const storedApproval = readLegacyApprovalFlags(session.summary?.metadata);
        const restoredApproval =
          storedApproval ??
          (await this.readMigratedLegacyApproval(session)) ??
          { yolo: defaultYoloMode, afk: false };
        const approval = withGlobalYoloMode(restoredApproval, defaultYoloMode);
        if (storedApproval === undefined || flagsDiffer(storedApproval, approval)) {
          await session.updateMetadata(legacyApprovalMetadata(approval));
        }
        const status = await session.getStatus();
        const permission = corePermissionForLegacyApproval(approval);
        if (status.permission !== permission) await session.setPermission(permission);
        runtime = this.wrapSession(session, approval);
      } catch (error) {
        await session.close().catch((closeError: unknown) => {
          this.log("Failed to close a rejected session", closeError);
        });
        throw error;
      }
    }
    runtime.subscribe(webviewId);
    this.sessionByView.set(webviewId, runtime.id);
    await runtime.announceStatus(webviewId);
    return runtime;
  }

  async detachView(webviewId: string): Promise<void> {
    const id = this.sessionByView.get(webviewId);
    if (id === undefined) return;
    this.sessionByView.delete(webviewId);
    const runtime = this.sessions.get(id);
    if (runtime === undefined) return;
    runtime.unsubscribeView(webviewId);
    if (runtime.subscribers.length === 0) {
      this.sessions.delete(id);
      await runtime.close();
    }
  }

  async closeSession(id: string): Promise<void> {
    const runtime = this.sessions.get(id);
    if (runtime === undefined) {
      await this.sessionHost.closeSession(id);
      return;
    }
    this.sessions.delete(id);
    for (const webviewId of runtime.subscribers) {
      this.sessionByView.delete(webviewId);
    }
    await runtime.close();
  }

  async deleteSession(id: string): Promise<void> {
    await this.closeSession(id);
    await this.sessionHost.deleteSession(id);
  }

  async setYoloModeForActiveSessions(enabled: boolean): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) => session.setLegacyYoloMode(enabled)),
    );
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    this.sessionByView.clear();
    await this.sessionHost.close();
  }

  private wrapSession(session: VscodeSessionPort, legacyApproval: LegacyApprovalFlags): SessionRuntime {
    const runtime = new SessionRuntime({
      session,
      legacyApproval,
      broadcast: this.broadcast,
      captureBaseline: this.captureBaseline,
      log: this.log,
    });
    this.sessions.set(session.id, runtime);
    return runtime;
  }

  private async readMigratedLegacyApproval(
    session: VscodeSessionPort,
  ): Promise<LegacyApprovalFlags | undefined> {
    const metadata = session.summary?.metadata;
    try {
      return await readMigratedLegacyApprovalFlags(metadata);
    } catch (error) {
      this.log("Unable to restore legacy session approval settings", error);
      return undefined;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Kimi runtime is closed.");
  }
}

async function applySessionSettings(
  session: VscodeSessionPort,
  options: OpenSessionOptions,
  legacyApproval: LegacyApprovalFlags,
): Promise<void> {
  const status = await session.getStatus();
  // Model and thinking effort are applied only when the session is created
  // (see openSession). An existing session keeps its own — the global config
  // values are defaults for new sessions, matching CLI/TUI resume semantics.
  // Changes made in the pickers reach the active session through the
  // SaveConfig handler instead.
  const permission = corePermissionForLegacyApproval(legacyApproval);
  if (status.permission !== permission) {
    await session.setPermission(permission);
  }
}

export function normalizeEffort(effort: string): string {
  return effort.trim() || "off";
}

function flagsDiffer(a: LegacyApprovalFlags, b: LegacyApprovalFlags): boolean {
  return a.yolo !== b.yolo || a.afk !== b.afk;
}

function assertSessionWorkDir(
  session: Pick<VscodeSessionPort, "workDir">,
  expectedWorkDir: string,
): void {
  if (!areSameFsPath(session.workDir, expectedWorkDir)) {
    throw new Error("The selected session belongs to a different working directory.");
  }
}
