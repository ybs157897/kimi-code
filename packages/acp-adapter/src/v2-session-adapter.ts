/**
 * `V2SessionAdapter` — an `IAcpSessionHost` implementation backed by
 * agent-core-v2 via Klient.
 *
 * Maps every method that `AcpSession` expects from a session handle to
 * the corresponding Klient facade/service call. Events from the
 * agent-scope event hub are forwarded to the old-style single-handler
 * `onEvent()` listener; approval/question interactions are detected
 * through the session interaction stream and bridged to the stored
 * handlers.
 *
 * This adapter is the bridge between the v2 engine (Klient) and the
 * ACP adapter's session wrapper (`AcpSession`), allowing the adapter to
 * hold Klient instead of the legacy `KimiHarness` / `Session`.
 */

import type {
  AgentEventPayloads,
  Klient,
  ResumedAgentState,
} from '@moonshot-ai/klient';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';
import type { ApprovalRequest, ApprovalResponse, QuestionRequest, QuestionResult } from '@moonshot-ai/kimi-code-sdk';

import type { IAcpSessionHost } from './iacp-session-host';

type Unsubscribe = () => void;

// Klient agent events type that carries `type` discriminator.
interface AgentEvent {
  readonly type: string;
  [key: string]: unknown;
}

// Session metadata entry for reading `sessionDir`
interface SessionMeta {
  readonly id: string;
  readonly sessionDir?: string;
  readonly agents?: Record<string, unknown>;
}

// Minimal interaction shape from the interactions.changed payload.
interface InteractionEntry {
  readonly id: string;
  readonly kind: 'approval' | 'question' | 'user_tool';
  readonly payload?: unknown;
  readonly origin?: { readonly agentId?: string; readonly turnId?: number };
  readonly createdAt?: number;
}

export class V2SessionAdapter implements IAcpSessionHost {
  readonly id: string;

  private readonly klient: Klient;
  private readonly sessionId: string;
  private sessionMeta: SessionMeta | undefined;
  private readonly replayState: Promise<ResumedAgentState | undefined>;
  private closed = false;

  constructor(
    klient: Klient,
    sessionId: string,
    sessionDir?: string,
  ) {
    this.klient = klient;
    this.sessionId = sessionId;
    this.id = sessionId;
    this.sessionMeta = sessionDir !== undefined ? { id: sessionId, sessionDir } : undefined;

    this.replayState = this.loadReplayState();
  }

  private get agent() {
    return this.klient.session(this.sessionId).agent('main');
  }

  private get session() {
    return this.klient.session(this.sessionId);
  }

  private async loadReplayState(): Promise<ResumedAgentState | undefined> {
    try {
      return await this.agent.replay.read();
    } catch {
      return undefined;
    }
  }

  // ── Resume state ─────────────────────────────────────────────────

  async getResumeState(): Promise<unknown> {
    const state = await this.replayState;
    if (state === undefined) return undefined;
    return {
      agents: {
        main: {
          context: state.context,
          config: state.config,
        },
      },
    };
  }

  get summary(): { readonly sessionDir?: string } | undefined {
    return this.sessionMeta;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async prompt(input: unknown): Promise<unknown> {
    if (this.closed) {
      throw Object.assign(new Error('session is closed'), { code: 'session.closed' });
    }
    if (!Array.isArray(input)) {
      throw new TypeError('prompt input must be an array');
    }
    return this.agent.prompt({ input: input as readonly ContentPart[] });
  }

  async activateSkill(name: string, args?: string): Promise<unknown> {
    if (this.closed) {
      throw Object.assign(new Error('session is closed'), { code: 'session.closed' });
    }
    return this.agent.skills.activate({ name, args });
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
    await this.agent.cancel();
  }

  async compact(options?: { instruction?: string }): Promise<unknown> {
    if (this.closed) {
      throw Object.assign(new Error('session is closed'), { code: 'session.closed' });
    }
    return this.agent.compact(options);
  }

  // ── Model / Permission ──────────────────────────────────────────────

  async setModel(modelId: string): Promise<unknown> {
    return this.agent.setModel(modelId);
  }

  async setThinking(effort: string): Promise<void> {
    await this.agent.profile.setThinking(effort);
  }

  async setPlanMode(enabled: boolean): Promise<void> {
    if (enabled) {
      await this.agent.enterPlan();
    } else {
      await this.agent.clearPlan();
    }
  }

  async setPermission(mode: string): Promise<void> {
    if (!isPermissionMode(mode)) {
      throw new TypeError(`unsupported permission mode: ${mode}`);
    }
    await this.agent.setPermission(mode);
  }

  // ── Status / Usage ─────────────────────────────────────────────────

  async getStatus(): Promise<any> {
    const [model, permission, plan, usage, context, replay] = await Promise.all([
      this.agent.getModel().catch(() => undefined),
      this.agent.getPermission().catch(() => undefined),
      this.agent.getPlan().catch(() => undefined),
      this.agent.getUsage().catch(() => undefined),
      this.agent.getContext().catch(() => undefined),
      this.replayState,
    ]);

    const contextTokens = context?.tokenCount ?? 0;
    const maxContextTokens =
      replay?.config.modelCapabilities?.max_context_tokens ?? 0;
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;

    // Derive thinking effort from the agent's profile
    let thinkingEffort = 'off';
    try {
      const profile = await this.agent.profile.get();
      thinkingEffort = (profile as { thinkingLevel?: string })?.thinkingLevel ?? 'off';
    } catch {
      // keep default
    }

    return {
      model: model ?? '',
      thinkingEffort,
      permission: permission ?? 'manual',
      planMode: plan !== null,
      contextTokens,
      maxContextTokens,
      contextUsage,
      usage: usage ?? {},
    };
  }

  async getUsage(): Promise<any> {
    const usage = await this.agent.getUsage().catch(() => ({}));
    return usage;
  }

  // ── MCP / Tasks / Skills ──────────────────────────────────────────

  async listMcpServers(): Promise<readonly any[]> {
    return this.agent.mcp.list();
  }

  async listBackgroundTasks(): Promise<readonly any[]> {
    return this.agent.getTasks();
  }

  async listSkills(): Promise<readonly any[]> {
    return this.session.skills.list();
  }

  // ── Events ─────────────────────────────────────────────────────────

  onEvent(listener: (event: AgentEvent) => void): Unsubscribe {
    const disposables: Array<{ dispose(): void }> = [];

    // Ensure interaction subscription is active so approval/question
    // interactions are bridged to the stored handlers.
    this.ensureInteractionSubscribed();

    // Subscribe to every typed agent event and forward to the single
    // handler. The Klient agent events already carry a `type` discriminator
    // matching the legacy SDK `Event.type`, so the AcpSession dispatch
    // works unchanged.
    const eventNames: readonly (keyof AgentEventPayloads)[] = [
      'turn.started',
      'turn.ended',
      'turn.step.started',
      'turn.step.retrying',
      'turn.step.interrupted',
      'turn.step.completed',
      'assistant.delta',
      'hook.result',
      'thinking.delta',
      'tool.call.delta',
      'tool.call.started',
      'tool.progress',
      'shell.output',
      'shell.started',
      'tool.result',
      'prompt.completed',
      'prompt.aborted',
      'goal.updated',
      'skill.activated',
      'plugin_command.activated',
      'permission.approval.requested',
      'permission.approval.resolved',
      'error',
      'warning',
      'notice',
      'agent.status.updated',
      'compaction.started',
      'compaction.blocked',
      'compaction.cancelled',
      'compaction.completed',
      'subagent.spawned',
      'subagent.started',
      'subagent.suspended',
      'subagent.completed',
      'subagent.failed',
      'task.started',
      'task.terminated',
      'cron.fired',
      'mcp.server.status',
      'tool.list.updated',
    ];

    for (const name of eventNames) {
      if (this.closed) break;
      const disposable = this.agent.events.on(name, (payload) => {
        if (this.closed) return;
        listener(payload as AgentEvent);
      });
      disposables.push(disposable);
    }

    return () => {
      for (const d of disposables) {
        d.dispose();
      }
    };
  }

  // ── Approval / Question reverse-RPC ────────────────────────────────

  private approvalHandler:
    | ((request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>)
    | undefined;

  private questionHandler:
    | ((request: QuestionRequest) => QuestionResult | Promise<QuestionResult>)
    | undefined;

  /** Track interaction IDs we've already forwarded to the handlers. */
  private readonly handledInteractions = new Set<string>();

  /** Whether the session interaction subscription is active. */
  private interactionSubscribed = false;

  setApprovalHandler(
    handler: ((request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>) | undefined,
  ): void {
    this.approvalHandler = handler;
  }

  setQuestionHandler(
    handler: ((request: QuestionRequest) => QuestionResult | Promise<QuestionResult>) | undefined,
  ): void {
    this.questionHandler = handler;
  }

  /**
   * Start listening for session interaction events and bridging them
   * to the approval/question handlers.
   *
   * Called from `onEvent()` since by that point both the session is active
   * and handlers are set. Safe to call multiple times — only one subscription
   * is created.
   */
  private ensureInteractionSubscribed(): void {
    if (this.interactionSubscribed || this.closed) return;
    this.interactionSubscribed = true;

    try {
      this.session.events.on('interactions.changed', (interactions) => {
        if (this.closed) return;
        void this.processInteractionChanges(interactions);
      });
    } catch {
      // Session events hub may not be available in all transports; silently skip.
    }
  }

  private async processInteractionChanges(interactions: unknown): Promise<void> {
    if (!Array.isArray(interactions)) return;

    for (const entry of interactions) {
      const interaction = entry as InteractionEntry;
      if (!interaction || typeof interaction.id !== 'string') continue;

      // Skip already-handled interactions
      if (this.handledInteractions.has(interaction.id)) continue;

      // Only process main-agent interactions
      const agentId = interaction.origin?.agentId;
      if (agentId !== undefined && agentId !== 'main') continue;

      switch (interaction.kind) {
        case 'approval':
          this.handledInteractions.add(interaction.id);
          void this.handleApprovalInteraction(interaction);
          break;
        case 'question':
          this.handledInteractions.add(interaction.id);
          void this.handleQuestionInteraction(interaction);
          break;
      }
    }
  }

  private async handleApprovalInteraction(interaction: InteractionEntry): Promise<void> {
    const handler = this.approvalHandler;
    if (!handler) return;

    // Build a legacy ApprovalRequest from the interaction payload.
    const payload = interaction.payload as Record<string, unknown> | undefined;
    const toolName = typeof payload?.['toolName'] === 'string' ? payload['toolName'] : 'unknown';
    const toolCallId = typeof payload?.['toolCallId'] === 'string' ? payload['toolCallId'] : interaction.id;
    const action = typeof payload?.['action'] === 'string' ? payload['action'] : toolName;

    // Display block: the payload may carry a display object or we build a minimal one.
    const displayPayload = payload?.['display'] ?? payload;
    const display = typeof displayPayload === 'object' && displayPayload !== null
      ? { kind: 'tool', ...displayPayload as Record<string, unknown> }
      : { kind: 'tool', description: toolName };

    const approvalRequest: ApprovalRequest = {
      toolCallId,
      toolName,
      action,
      display: display as ApprovalRequest['display'],
    };

    try {
      const response = await handler(approvalRequest);
      // Send the response back to the engine via session approvals service
      await this.session.approvals.decide(interaction.id, response);
    } catch {
      // Handler error: reject the approval with a graceful error
      try {
        await this.session.approvals.decide(interaction.id, { decision: 'rejected' });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  private async handleQuestionInteraction(interaction: InteractionEntry): Promise<void> {
    const handler = this.questionHandler;
    if (!handler) return;

    // Build a legacy QuestionRequest from the interaction payload.
    const payload = interaction.payload as Record<string, unknown> | undefined;
    const questions = Array.isArray(payload?.['questions']) ? payload['questions'] : [];
    const toolCallId = typeof payload?.['toolCallId'] === 'string' ? payload['toolCallId'] : interaction.id;

    const questionRequest: QuestionRequest = {
      questions: questions.map(toQuestionItem),
      toolCallId,
    };

    try {
      const result = await handler(questionRequest);
      // Send the answer back to the engine
      if (result !== null) {
        await this.session.questions.answer(interaction.id, result);
      } else {
        await this.session.questions.dismiss(interaction.id);
      }
    } catch {
      // Handler error: dismiss gracefully
      try {
        await this.session.questions.dismiss(interaction.id);
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  /** Mark this adapter as closed. Subsequent operations return coded errors. */
  markClosed(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function isPermissionMode(mode: string): mode is PermissionMode {
  return mode === 'manual' || mode === 'auto' || mode === 'yolo';
}

function toQuestionItem(value: unknown): QuestionRequest['questions'][number] {
  const item =
    typeof value === 'object' && value !== null
      ? value as Record<string, unknown>
      : {};
  return {
    question: typeof item['question'] === 'string' ? item['question'] : '',
    options: Array.isArray(item['options'])
      ? item['options'].filter(isQuestionOption)
      : [],
    ...(typeof item['id'] === 'string' ? { id: item['id'] } : {}),
    ...(item['multiSelect'] === true ? { multiSelect: true } : {}),
  };
}

function isQuestionOption(
  value: unknown,
): value is QuestionRequest['questions'][number]['options'][number] {
  return (
    typeof value === 'object' &&
    value !== null &&
    'label' in value &&
    typeof value.label === 'string'
  );
}
