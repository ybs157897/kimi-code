/**
 * Fake implementations of {@link AcpHost} and {@link AcpSessionHost}
 * for protocol-level tests that must not depend on a specific engine.
 *
 * These fakes support scripted events, parameter capture, and error
 * injection — enough to exercise every ACP method handler without
 * instantiating a real or stubbed engine session.
 */

import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
} from '@moonshot-ai/kimi-code-sdk';
import type { KimiHarness, ModelAlias } from '@moonshot-ai/kimi-code-sdk';

import type {
  AcpCreateSessionParams,
  AcpHost,
  AcpImageLimits,
  AcpListSessionsParams,
  AcpModelEntry,
  AcpProtocolEvent,
  AcpResumeSessionParams,
  AcpSessionHost,
  AcpSessionSummary,
} from '../../src/types';

import type { IAcpSessionHost } from '../../src/iacp-session-host';

/**
 * Default model entries for tests that need a thinking-capable model.
 */
export const DEFAULT_MODELS: readonly AcpModelEntry[] = [
  {
    id: 'kimi-coder',
    name: 'Kimi Coder',
    thinkingSupported: true,
    supportEfforts: [],
    defaultThinkingEffort: 'on',
  },
  {
    id: 'kimi-plain',
    name: 'Kimi Plain',
    thinkingSupported: false,
    supportEfforts: [],
    defaultThinkingEffort: 'on',
  },
];

type Unsubscribe = () => void;

/**
 * Scripted session host: replays pre-recorded events in order and
 * supports test injection of approval/question handlers, model changes,
 * and status responses.
 */
export class FakeAcpSessionHost implements IAcpSessionHost {
  readonly id: string;
  readonly summary?: { readonly sessionDir?: string };

  /** Accumulated events emitted by this host (for inspection). */
  readonly emittedEvents: AcpProtocolEvent[] = [];

  /** Last model id set via setModel. */
  lastSetModel: string | undefined;

  /** Last thinking effort set via setThinking. */
  lastSetThinking: string | undefined;

  /** Last plan mode set via setPlanMode. */
  lastSetPlanMode: boolean | undefined;

  /** Last permission mode set via setPermission. */
  lastSetPermission: string | undefined;

  /** Last activateSkill arguments. */
  lastActivateSkill: { name: string; args?: string } | undefined;

  /** Approval handler registered via setApprovalHandler. */
  approvalHandler: ((request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>) | undefined;

  /** Question handler registered via setQuestionHandler. */
  questionHandler: ((request: QuestionRequest) => QuestionResult | Promise<QuestionResult>) | undefined;

  private readonly listeners = new Set<(event: unknown) => void>();
  private readonly scriptedEvents: readonly AcpProtocolEvent[];
  private readonly statusOverride: (() => Promise<unknown>) | undefined;
  private readonly usageOverride: (() => Promise<unknown>) | undefined;
  private readonly resumeState: unknown;
  private compactCalled = false;
  private lastCompactInstruction: string | undefined;

  constructor(params: {
    id: string;
    scriptedEvents?: readonly AcpProtocolEvent[];
    status?: () => Promise<unknown>;
    usage?: () => Promise<unknown>;
    resumeState?: unknown;
    summary?: { sessionDir?: string };
  }) {
    this.id = params.id;
    this.scriptedEvents = params.scriptedEvents ?? [];
    this.statusOverride = params.status;
    this.usageOverride = params.usage;
    this.resumeState = params.resumeState;
    this.summary = params.summary;
  }

  async cancel(): Promise<void> {
    // no-op in fakes
  }

  async prompt(_input: unknown): Promise<unknown> {
    for (const ev of this.scriptedEvents) {
      this.emittedEvents.push(ev);
      for (const fn of this.listeners) fn(ev);
    }
    return undefined;
  }

  async activateSkill(name: string, args?: string): Promise<unknown> {
    this.lastActivateSkill = { name, args };
    return undefined;
  }

  onEvent(listener: (event: unknown) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async setModel(modelId: string): Promise<unknown> {
    this.lastSetModel = modelId;
    return undefined;
  }

  async setThinking(effort: string): Promise<void> {
    this.lastSetThinking = effort;
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    this.lastSetPlanMode = enabled;
  }

  async setPermission(mode: string): Promise<void> {
    this.lastSetPermission = mode;
  }

  setApprovalHandler(handler: ((request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>) | undefined): void {
    this.approvalHandler = handler;
  }

  setQuestionHandler(handler: ((request: QuestionRequest) => QuestionResult | Promise<QuestionResult>) | undefined): void {
    this.questionHandler = handler;
  }

  async getStatus(): Promise<unknown> {
    if (this.statusOverride) return this.statusOverride();
    return {
      model: 'kimi-coder',
      thinkingEffort: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 128000,
      contextUsage: 0,
      contextAvailable: true,
    };
  }

  async getUsage(): Promise<unknown> {
    if (this.usageOverride) return this.usageOverride();
    return {
      total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    };
  }

  getResumeState(): unknown {
    return this.resumeState;
  }

  async compact(options?: { instruction?: string }): Promise<unknown> {
    this.compactCalled = true;
    this.lastCompactInstruction = options?.instruction;
    return undefined;
  }

  async listMcpServers(): Promise<readonly unknown[]> {
    return [];
  }

  async listBackgroundTasks(): Promise<readonly unknown[]> {
    return [];
  }

  async listSkills(): Promise<readonly unknown[]> {
    return [];
  }

  /** Whether compact() was called. */
  get wasCompactCalled(): boolean {
    return this.compactCalled;
  }

  /** The instruction passed to compact(). */
  get compactInstruction(): string | undefined {
    return this.lastCompactInstruction;
  }
}

/**
 * Fake host for protocol-level testing.
 */
export class FakeAcpHost implements AcpHost {
  readonly imageLimits: AcpImageLimits | undefined;
  readonly createdSessions: Array<{ params: AcpCreateSessionParams; host: IAcpSessionHost }> = [];
  readonly resumedSessions: Array<{ params: AcpResumeSessionParams; host: IAcpSessionHost }> = [];

  authenticated = true;
  models: readonly AcpModelEntry[] = DEFAULT_MODELS;
  sessionSummaries: AcpSessionSummary[] = [];
  createError: Error | undefined;
  resumeError: Error | undefined;
  sessionHostFactory: ((id: string) => IAcpSessionHost) | undefined;
  readonly telemetryEvents: Array<{ event: string; properties?: Record<string, unknown> }> = [];

  constructor(opts?: {
    authenticated?: boolean;
    models?: readonly AcpModelEntry[];
    sessionSummaries?: AcpSessionSummary[];
    imageLimits?: AcpImageLimits;
  }) {
    this.authenticated = opts?.authenticated ?? true;
    if (opts?.models) this.models = opts.models;
    if (opts?.sessionSummaries) this.sessionSummaries = opts.sessionSummaries;
    this.imageLimits = opts?.imageLimits;
  }

  async checkAuthenticated(): Promise<boolean> {
    return this.authenticated;
  }

  async createSession(params: AcpCreateSessionParams): Promise<AcpSessionHost> {
    if (this.createError) throw this.createError;
    const host: IAcpSessionHost = this.sessionHostFactory?.(params.sessionId) ?? new FakeAcpSessionHost({ id: params.sessionId });
    this.createdSessions.push({ params, host });
    return host as AcpSessionHost;
  }

  async resumeSession(params: AcpResumeSessionParams): Promise<AcpSessionHost> {
    if (this.resumeError) throw this.resumeError;
    const host: IAcpSessionHost = this.sessionHostFactory?.(params.sessionId) ?? new FakeAcpSessionHost({ id: params.sessionId });
    this.resumedSessions.push({ params, host });
    return host as AcpSessionHost;
  }

  async listSessions(_params?: AcpListSessionsParams): Promise<AcpSessionSummary[]> {
    return this.sessionSummaries;
  }

  async listAvailableModels(): Promise<readonly AcpModelEntry[]> {
    return this.models;
  }

  track(event: string, properties?: Record<string, unknown>): void {
    this.telemetryEvents.push({ event, properties });
  }
}

/**
 * Convert a partial KimiHarness stub to an AcpHost for test backward compat.
 *
 * Used by tests that were written against the old KimiHarness-based
 * server constructor. Wraps the harness's auth.status() and creates
 * FakeAcpSessionHost instances for every session.
 */
export function stubHarnessToHost(harness: Partial<KimiHarness>): AcpHost {
  return {
    async checkAuthenticated(): Promise<boolean> {
      if (typeof harness.auth?.status !== 'function') return false;
      try {
        const status = await harness.auth.status();
        return status.providers.some((p: any) => p.hasToken === true);
      } catch {
        return false;
      }
    },
    async createSession(params: AcpCreateSessionParams): Promise<AcpSessionHost> {
      const sh = new FakeAcpSessionHost({ id: params.sessionId });
      return sh as unknown as AcpSessionHost;
    },
    async resumeSession(params: AcpResumeSessionParams): Promise<AcpSessionHost> {
      const sh = new FakeAcpSessionHost({ id: params.sessionId });
      return sh as unknown as AcpSessionHost;
    },
    async listSessions(_params?: AcpListSessionsParams): Promise<AcpSessionSummary[]> {
      return [];
    },
    async listAvailableModels(): Promise<readonly AcpModelEntry[]> {
      return DEFAULT_MODELS;
    },
  };
}
