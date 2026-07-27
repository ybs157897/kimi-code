import type {
  ApprovalHandler,
  ApprovalRequest as LegacyApprovalRequest,
  ApprovalResponse as LegacyApprovalResponse,
  Event,
  QuestionHandler,
  QuestionRequest as LegacyQuestionRequest,
  QuestionResult as LegacyQuestionResult,
  Session,
  ToolInputDisplay,
} from '@moonshot-ai/kimi-code-sdk';

import {
  TUI_AGENT_EVENT_TYPES,
  type TUIAgentEvent,
  type TUIAgentEventListener,
  type TUIAgentReplay,
  type TUIReplayContextMessage,
} from './agent-events-port';
import {
  projectTUIAgentReplay,
  type TUIAgentReplaySource,
} from './agent-replay';
import type {
  SessionScopedEventsPort,
  TUIApprovalDisplay,
  TUIApprovalRequest,
  TUIApprovalResponse,
  TUIInteraction,
  TUIQuestionRequest,
  TUIQuestionResult,
  TUISessionScopedEvent,
  TUISessionScopedEventListener,
  TUIWireValue,
} from './session-events-port';

export interface LegacySessionEventsSource {
  readonly id: string;
  onEvent(listener: (event: Event) => void): ReturnType<Session['onEvent']>;
  setApprovalHandler(handler: ApprovalHandler | undefined): void;
  setQuestionHandler(handler: QuestionHandler | undefined): void;
  getResumeState(): ReturnType<Session['getResumeState']>;
}

interface PendingApproval {
  readonly resolve: (response: LegacyApprovalResponse) => void;
}

interface PendingQuestion {
  readonly resolve: (result: LegacyQuestionResult) => void;
}

export interface LegacySessionEventsBroker {
  subscribeSession(listener: TUISessionScopedEventListener): () => void;
  subscribeAgent(agentId: string, listener: TUIAgentEventListener): () => void;
  subscribeAllAgents(listener: TUIAgentEventListener): () => void;
  readReplay(agentId: string): Promise<TUIAgentReplay | undefined>;
  respondToApproval(id: string, response: TUIApprovalResponse): Promise<void>;
  respondToQuestion(id: string, result: TUIQuestionResult): Promise<void>;
}

const agentEventTypes = new Set<string>(TUI_AGENT_EVENT_TYPES);
const brokers = new WeakMap<LegacySessionEventsSource, LegacySessionEventsBroker>();

/**
 * Return the single event broker for a legacy Session. Session and agent ports
 * share its one SDK event stream and reverse-RPC handler pair.
 */
export function getLegacySessionEventsBroker(
  session: LegacySessionEventsSource,
): LegacySessionEventsBroker {
  const existing = brokers.get(session);
  if (existing !== undefined) return existing;
  const broker = createLegacySessionEventsBroker(session);
  brokers.set(session, broker);
  return broker;
}

/** Bridge the legacy callback-based Session into its pure session event port. */
export function createLegacySessionScopedEventsPort(
  session: LegacySessionEventsSource,
): SessionScopedEventsPort {
  const broker = getLegacySessionEventsBroker(session);
  return {
    subscribe: (listener) => broker.subscribeSession(listener),
    respondToApproval: (id, response) => broker.respondToApproval(id, response),
    respondToQuestion: (id, result) => broker.respondToQuestion(id, result),
  };
}

function createLegacySessionEventsBroker(
  session: LegacySessionEventsSource,
): LegacySessionEventsBroker {
  const sessionListeners = new Set<TUISessionScopedEventListener>();
  const agentListeners = new Map<string, Set<TUIAgentEventListener>>();
  const allAgentListeners = new Set<TUIAgentEventListener>();
  const pendingApprovals = new Map<string, PendingApproval>();
  const pendingQuestions = new Map<string, PendingQuestion>();
  let unsubscribeEvents: (() => void) | undefined;
  let listenerCount = 0;
  let questionSequence = 0;

  const emitSession = (event: TUISessionScopedEvent): void => {
    for (const listener of sessionListeners) listener(event);
  };

  const emitAgent = (event: TUIAgentEvent): void => {
    for (const listener of agentListeners.get(event.agentId) ?? []) listener(event);
    for (const listener of allAgentListeners) listener(event);
  };

  const emitInteraction = (interaction: TUIInteraction): void => {
    emitSession({ type: 'interaction.requested', interaction });
  };

  const approvalHandler: ApprovalHandler = (request) => {
    const id = request.toolCallId;
    return new Promise<LegacyApprovalResponse>((resolve) => {
      pendingApprovals.set(id, { resolve });
      emitInteraction({
        id,
        kind: 'approval',
        sessionId: session.id,
        agentId: runtimeAgentId(request),
        turnId: request.turnId,
        request: copyLegacyApprovalRequest(request),
      });
    });
  };

  const questionHandler: QuestionHandler = (request) => {
    questionSequence += 1;
    const id =
      request.toolCallId ??
      `question:${request.turnId === undefined ? 'pending' : String(request.turnId)}:${String(questionSequence)}`;
    return new Promise<LegacyQuestionResult>((resolve) => {
      pendingQuestions.set(id, { resolve });
      emitInteraction({
        id,
        kind: 'question',
        sessionId: session.id,
        agentId: runtimeAgentId(request),
        turnId: request.turnId,
        request: copyLegacyQuestionRequest(request),
      });
    });
  };

  const connect = (): void => {
    unsubscribeEvents = session.onEvent((event) => {
      if (agentEventTypes.has(event.type)) {
        emitAgent(event as TUIAgentEvent);
        return;
      }
      if (event.type === 'session.meta.updated') {
        emitSession({
          type: 'session.metadata.changed',
          sessionId: session.id,
          changed: metadataChangedKeys(event.title, event.patch),
          title: event.title,
          patch: event.patch,
        });
        return;
      }
      if (event.type === 'expert_team.updated') {
        emitSession({
          type: 'session.expert-team.changed',
          sessionId: session.id,
          snapshot: event.status,
        });
      }
    });
    session.setApprovalHandler(approvalHandler);
    session.setQuestionHandler(questionHandler);
  };

  const disconnect = (): void => {
    unsubscribeEvents?.();
    unsubscribeEvents = undefined;
    session.setApprovalHandler(undefined);
    session.setQuestionHandler(undefined);
    for (const pending of pendingApprovals.values()) {
      pending.resolve({
        decision: 'cancelled',
        feedback: 'session event subscription closed',
      });
    }
    for (const pending of pendingQuestions.values()) pending.resolve(null);
    pendingApprovals.clear();
    pendingQuestions.clear();
  };

  const retain = (): void => {
    listenerCount += 1;
    if (listenerCount === 1) connect();
  };

  const release = (): void => {
    listenerCount -= 1;
    if (listenerCount === 0) disconnect();
  };

  return {
    subscribeSession(listener) {
      sessionListeners.add(listener);
      retain();

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        sessionListeners.delete(listener);
        release();
      };
    },

    subscribeAgent(agentId, listener) {
      let listeners = agentListeners.get(agentId);
      if (listeners === undefined) {
        listeners = new Set();
        agentListeners.set(agentId, listeners);
      }
      listeners.add(listener);
      retain();

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        if (listeners.size === 0) agentListeners.delete(agentId);
        release();
      };
    },

    subscribeAllAgents(listener) {
      allAgentListeners.add(listener);
      retain();

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        allAgentListeners.delete(listener);
        release();
      };
    },

    async readReplay(agentId) {
      const state = session.getResumeState();
      const agent = state?.agents[agentId];
      if (agent === undefined) return undefined;
      return projectTUIAgentReplay(
        legacyReplaySource(agent),
        state?.warning,
      );
    },

    async respondToApproval(id, response) {
      const pending = pendingApprovals.get(id);
      if (pending === undefined) throw new Error(`Unknown approval interaction: ${id}`);
      pendingApprovals.delete(id);
      const copied = copyApprovalResponse(response);
      pending.resolve(copied);
      emitSession({
        type: 'interaction.resolved',
        id,
        sessionId: session.id,
        kind: 'approval',
        response: copied,
      });
    },

    async respondToQuestion(id, result) {
      const pending = pendingQuestions.get(id);
      if (pending === undefined) throw new Error(`Unknown question interaction: ${id}`);
      pendingQuestions.delete(id);
      const copied = copyQuestionResult(result);
      pending.resolve(copied);
      emitSession({
        type: 'interaction.resolved',
        id,
        sessionId: session.id,
        kind: 'question',
        response: copied,
      });
    },
  };
}

function legacyReplaySource(
  agent: NonNullable<
    ReturnType<LegacySessionEventsSource['getResumeState']>
  >['agents'][string],
): TUIAgentReplaySource {
  return {
    type: agent.type,
    config: agent.config,
    context: {
      history: agent.context.history as readonly TUIReplayContextMessage[],
      tokenCount: agent.context.tokenCount,
    },
    replay: agent.replay as TUIAgentReplaySource['replay'],
    permission: agent.permission,
    plan: agent.plan,
    swarmMode: agent.swarmMode,
    usage: agent.usage,
    tools: agent.tools,
    background: agent.background,
    toolStore: agent.toolStore,
  };
}

function metadataChangedKeys(
  title: string | undefined,
  patch: Record<string, unknown> | undefined,
): readonly string[] {
  const changed = new Set(Object.keys(patch ?? {}));
  if (title !== undefined) changed.add('title');
  return [...changed];
}

function runtimeAgentId(request: object): string {
  const agentId = (request as { agentId?: unknown }).agentId;
  return typeof agentId === 'string' ? agentId : 'main';
}

function copyLegacyApprovalRequest(
  request: LegacyApprovalRequest,
): TUIApprovalRequest {
  return {
    turnId: request.turnId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    action: request.action,
    display: copyLegacyApprovalDisplay(request.display),
  };
}

function copyLegacyApprovalDisplay(
  display: ToolInputDisplay,
): TUIApprovalDisplay {
  switch (display.kind) {
    case 'command':
      return {
        kind: 'command',
        command: display.command,
        cwd: display.cwd,
        description: display.description,
        language: display.language,
      };
    case 'file_io':
      return {
        kind: 'file_io',
        operation: display.operation,
        path: display.path,
        detail: display.detail,
        content: display.content,
        before: display.before,
        after: display.after,
      };
    case 'diff':
      return {
        kind: 'diff',
        path: display.path,
        before: display.before,
        after: display.after,
        hunks: display.hunks,
      };
    case 'search':
      return { kind: 'search', query: display.query, scope: display.scope };
    case 'url_fetch':
      return { kind: 'url_fetch', url: display.url, method: display.method };
    case 'agent_call':
      return {
        kind: 'agent_call',
        agent_name: display.agent_name,
        prompt: display.prompt,
        background: display.background,
      };
    case 'skill_call':
      return {
        kind: 'skill_call',
        skill_name: display.skill_name,
        args: display.args,
      };
    case 'todo_list':
      return {
        kind: 'todo_list',
        items: display.items.map((item) => ({
          title: item.title,
          status: item.status,
        })),
      };
    case 'task':
      return {
        kind: 'task',
        task_id: display.task_id,
        status: display.status,
        description: display.description,
        task_kind: display.task_kind,
      };
    case 'task_stop':
      return {
        kind: 'task_stop',
        task_id: display.task_id,
        task_description: display.task_description,
      };
    case 'plan_review':
      return {
        kind: 'plan_review',
        plan: display.plan,
        path: display.path,
        options: display.options?.map((option) => ({
          label: option.label,
          description: option.description,
        })),
      };
    case 'goal_start':
      return {
        kind: 'goal_start',
        objective: display.objective,
        completionCriterion: display.completionCriterion,
        mode: display.mode,
      };
    case 'generic':
      return {
        kind: 'generic',
        summary: display.summary,
        detail: copyWireValue(display.detail),
      };
  }
}

function copyLegacyQuestionRequest(
  request: LegacyQuestionRequest,
): TUIQuestionRequest {
  return {
    turnId: request.turnId,
    toolCallId: request.toolCallId,
    questions: request.questions.map((question) => ({
      question: question.question,
      header: question.header,
      body: question.body,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
      multiSelect: question.multiSelect,
      otherLabel: question.otherLabel,
      otherDescription: question.otherDescription,
    })),
  };
}

function copyApprovalResponse(
  response: TUIApprovalResponse,
): TUIApprovalResponse {
  return {
    decision: response.decision,
    scope: response.scope,
    feedback: response.feedback,
    selectedLabel: response.selectedLabel,
  };
}

function copyQuestionResult(
  result: TUIQuestionResult,
): TUIQuestionResult {
  if (result === null) return null;
  if (isQuestionResponse(result)) {
    return {
      answers: { ...result.answers },
      method: result.method,
    };
  }
  return { ...result };
}

function isQuestionResponse(
  result: Exclude<TUIQuestionResult, null>,
): result is Extract<TUIQuestionResult, { readonly answers: object }> {
  return typeof result['answers'] === 'object' && result['answers'] !== null;
}

function copyWireValue(value: unknown): TUIWireValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const copied: TUIWireValue[] = [];
    for (const item of value) {
      const copiedItem = copyWireValue(item);
      if (copiedItem === undefined) return undefined;
      copied.push(copiedItem);
    }
    return copied;
  }
  if (typeof value !== 'object' || value === undefined) return undefined;
  const copied: Record<string, TUIWireValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const copiedItem = copyWireValue(item);
    if (copiedItem !== undefined) copied[key] = copiedItem;
  }
  return copied;
}
