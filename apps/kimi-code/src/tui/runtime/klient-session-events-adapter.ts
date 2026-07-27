import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type {
  SessionEventsPort,
  SessionScopedEventsPort,
  TUIApprovalDisplay,
  TUIApprovalInteraction,
  TUIApprovalResponse,
  TUIInteraction,
  TUIQuestionItem,
  TUIQuestionInteraction,
  TUIQuestionResult,
  TUISessionScopedEvent,
  TUISessionScopedEventListener,
  TUIWireValue,
} from './session-events-port';
import { createKlientAgentEventsPort } from './klient-agent-events-adapter';
import { projectKlientExpertTeamSnapshot } from './klient-session-expert-team-adapter';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;
type KlientDisposable = ReturnType<KlientSessionFacade['events']['onError']>;
type KlientPendingInteraction = Awaited<
  ReturnType<KlientSessionFacade['interactions']['list']>
>[number];

/** Bridge one Klient session scope into its pure session event port. */
export function createKlientSessionScopedEventsPort(
  session: KlientSessionFacade,
  sessionId: string,
  defaultAgentId = 'main',
): SessionScopedEventsPort {
  const listeners = new Set<TUISessionScopedEventListener>();
  const pendingKinds = new Map<string, TUIInteraction['kind']>();
  const disposables: KlientDisposable[] = [];
  let connected = false;
  let connectionVersion = 0;

  const emit = (event: TUISessionScopedEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const handlePending = (pending: readonly KlientPendingInteraction[]): void => {
    for (const interaction of pending) {
      if (pendingKinds.has(interaction.id)) continue;
      const normalized = normalizeInteraction(sessionId, defaultAgentId, interaction);
      if (normalized === undefined) continue;
      pendingKinds.set(normalized.id, normalized.kind);
      emit({ type: 'interaction.requested', interaction: normalized });
    }
  };

  const connect = (): void => {
    connected = true;
    connectionVersion += 1;
    const version = connectionVersion;

    disposables.push(
      session.events.on('metadata.changed', (event) => {
        const changed = [...event.changed];
        const baseEvent = {
          type: 'session.metadata.changed',
          sessionId,
          changed,
        } as const;
        if (!changed.includes('title')) {
          emit(baseEvent);
          return;
        }
        void session.get().then(
          (metadata) => {
            if (!connected || version !== connectionVersion) return;
            emit({ ...baseEvent, title: metadata.title });
          },
          () => {
            if (!connected || version !== connectionVersion) return;
            emit(baseEvent);
          },
        );
      }),
      session.events.on('expert-team.changed', (snapshot) => {
        emit({
          type: 'session.expert-team.changed',
          sessionId,
          snapshot:
            snapshot === null
              ? null
              : projectKlientExpertTeamSnapshot(snapshot),
        });
      }),
      session.events.on('interactions.changed', (pending) => {
        handlePending(pending);
      }),
      session.events.on('interactions.resolved', (resolution) => {
        const kind = pendingKinds.get(resolution.id);
        pendingKinds.delete(resolution.id);
        if (kind === 'approval') {
          const response = normalizeApprovalResponse(resolution.response);
          if (response === undefined) return;
          emit({
            type: 'interaction.resolved',
            id: resolution.id,
            sessionId,
            kind,
            response,
          });
          return;
        }
        if (kind === 'question') {
          const normalized = normalizeQuestionResult(resolution.response);
          if (!normalized.valid) return;
          emit({
            type: 'interaction.resolved',
            id: resolution.id,
            sessionId,
            kind,
            response: normalized.result,
          });
        }
      }),
    );

    void session.interactions.list().then(
      (pending) => {
        if (connected && version === connectionVersion) handlePending(pending);
      },
      () => undefined,
    );
  };

  const disconnect = (): void => {
    connected = false;
    connectionVersion += 1;
    for (const disposable of disposables.splice(0)) disposable.dispose();
    pendingKinds.clear();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) connect();

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        if (listeners.size === 0) disconnect();
      };
    },

    respondToApproval: (id, response) =>
      session.approvals.decide(id, copyApprovalResponse(response)),
    respondToQuestion: (id, result) =>
      session.questions.answer(id, copyQuestionResult(result)),
  };
}

/**
 * @deprecated Combined compatibility port for the pre-split TUI controller.
 * Its session side is the same scoped adapter used by new consumers.
 */
export function createKlientSessionEventsPort(
  session: KlientSessionFacade,
  sessionId: string,
  agentId = 'main',
): SessionEventsPort {
  const sessionEvents = createKlientSessionScopedEventsPort(session, sessionId, agentId);
  const agentEvents = createKlientAgentEventsPort(session, sessionId, agentId);
  return {
    subscribe(listener) {
      const unsubscribeSession = sessionEvents.subscribe(listener);
      const unsubscribeAgent = agentEvents.subscribe(listener);
      return () => {
        unsubscribeSession();
        unsubscribeAgent();
      };
    },
    readReplay(requestedAgentId = agentId) {
      if (requestedAgentId === agentId) return agentEvents.readReplay();
      return createKlientAgentEventsPort(session, sessionId, requestedAgentId).readReplay();
    },
    respondToApproval: (id, response) => sessionEvents.respondToApproval(id, response),
    respondToQuestion: (id, result) => sessionEvents.respondToQuestion(id, result),
  };
}

function normalizeInteraction(
  sessionId: string,
  defaultAgentId: string,
  interaction: KlientPendingInteraction,
): TUIInteraction | undefined {
  if (!isRecord(interaction.payload)) return undefined;
  if (interaction.kind === 'approval') {
    const toolName = interaction.payload['toolName'];
    const action = interaction.payload['action'];
    if (typeof toolName !== 'string' || typeof action !== 'string') return undefined;
    const display = normalizeApprovalDisplay(interaction.payload['display']);
    if (display === undefined) return undefined;
    const toolCallId =
      typeof interaction.payload['toolCallId'] === 'string'
        ? interaction.payload['toolCallId']
        : interaction.id;
    const request = {
      turnId:
        typeof interaction.payload['turnId'] === 'number'
          ? interaction.payload['turnId']
          : undefined,
      toolCallId,
      toolName,
      action,
      display,
    };
    const normalized: TUIApprovalInteraction = {
      id: interaction.id,
      kind: 'approval',
      sessionId,
      agentId: interaction.origin.agentId ?? defaultAgentId,
      turnId: interaction.origin.turnId,
      createdAt: interaction.createdAt,
      request,
    };
    return normalized;
  }
  if (interaction.kind === 'question') {
    const questions = normalizeQuestionItems(interaction.payload['questions']);
    if (questions === undefined) return undefined;
    const request = {
      turnId:
        typeof interaction.payload['turnId'] === 'number'
          ? interaction.payload['turnId']
          : undefined,
      toolCallId:
        typeof interaction.payload['toolCallId'] === 'string'
          ? interaction.payload['toolCallId']
          : undefined,
      questions,
    };
    const normalized: TUIQuestionInteraction = {
      id: interaction.id,
      kind: 'question',
      sessionId,
      agentId: interaction.origin.agentId ?? defaultAgentId,
      turnId: interaction.origin.turnId,
      createdAt: interaction.createdAt,
      request,
    };
    return normalized;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeApprovalDisplay(
  value: unknown,
): TUIApprovalDisplay | undefined {
  if (!isRecord(value) || typeof value['kind'] !== 'string') return undefined;
  switch (value['kind']) {
    case 'command': {
      const command = stringField(value, 'command');
      if (command === undefined) return undefined;
      return {
        kind: 'command',
        command,
        cwd: stringField(value, 'cwd'),
        description: stringField(value, 'description'),
        language: value['language'] === 'bash' ? 'bash' : undefined,
      };
    }
    case 'file_io': {
      const operation = value['operation'];
      const path = stringField(value, 'path');
      if (!isFileOperation(operation) || path === undefined) return undefined;
      return {
        kind: 'file_io',
        operation,
        path,
        detail: stringField(value, 'detail'),
        content: stringField(value, 'content'),
        before: stringField(value, 'before'),
        after: stringField(value, 'after'),
      };
    }
    case 'diff': {
      const path = stringField(value, 'path');
      const before = stringField(value, 'before');
      const after = stringField(value, 'after');
      if (path === undefined || before === undefined || after === undefined) return undefined;
      return {
        kind: 'diff',
        path,
        before,
        after,
        hunks: numberField(value, 'hunks'),
      };
    }
    case 'search': {
      const query = stringField(value, 'query');
      if (query === undefined) return undefined;
      return { kind: 'search', query, scope: stringField(value, 'scope') };
    }
    case 'url_fetch': {
      const url = stringField(value, 'url');
      if (url === undefined) return undefined;
      return { kind: 'url_fetch', url, method: stringField(value, 'method') };
    }
    case 'agent_call': {
      const agentName = stringField(value, 'agent_name');
      const prompt = stringField(value, 'prompt');
      if (agentName === undefined || prompt === undefined) return undefined;
      return {
        kind: 'agent_call',
        agent_name: agentName,
        prompt,
        background: booleanField(value, 'background'),
      };
    }
    case 'skill_call': {
      const skillName = stringField(value, 'skill_name');
      if (skillName === undefined) return undefined;
      return {
        kind: 'skill_call',
        skill_name: skillName,
        args: stringField(value, 'args'),
      };
    }
    case 'todo_list': {
      const items = normalizeTodoItems(value['items']);
      if (items === undefined) return undefined;
      return { kind: 'todo_list', items };
    }
    case 'task': {
      const taskId = stringField(value, 'task_id');
      const status = stringField(value, 'status');
      const description = stringField(value, 'description');
      if (taskId === undefined || status === undefined || description === undefined) {
        return undefined;
      }
      return {
        kind: 'task',
        task_id: taskId,
        status,
        description,
        task_kind: stringField(value, 'task_kind'),
      };
    }
    case 'task_stop': {
      const taskId = stringField(value, 'task_id');
      const taskDescription = stringField(value, 'task_description');
      if (taskId === undefined || taskDescription === undefined) return undefined;
      return {
        kind: 'task_stop',
        task_id: taskId,
        task_description: taskDescription,
      };
    }
    case 'plan_review': {
      const plan = stringField(value, 'plan');
      if (plan === undefined) return undefined;
      return {
        kind: 'plan_review',
        plan,
        path: stringField(value, 'path'),
        options: normalizeApprovalOptions(value['options']),
      };
    }
    case 'goal_start': {
      const objective = stringField(value, 'objective');
      const mode = value['mode'];
      if (objective === undefined || (mode !== 'manual' && mode !== 'yolo')) return undefined;
      return {
        kind: 'goal_start',
        objective,
        completionCriterion: stringField(value, 'completionCriterion'),
        mode,
      };
    }
    case 'generic': {
      const summary = stringField(value, 'summary');
      if (summary === undefined) return undefined;
      return {
        kind: 'generic',
        summary,
        detail: copyWireValue(value['detail']),
      };
    }
    default:
      return undefined;
  }
}

function normalizeQuestionItems(value: unknown): readonly TUIQuestionItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions: TUIQuestionItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const question = stringField(item, 'question');
    const options = normalizeQuestionOptions(item['options']);
    if (question === undefined || options === undefined) return undefined;
    questions.push({
      question,
      header: stringField(item, 'header'),
      body: stringField(item, 'body'),
      options,
      multiSelect: booleanField(item, 'multiSelect'),
      otherLabel: stringField(item, 'otherLabel'),
      otherDescription: stringField(item, 'otherDescription'),
    });
  }
  return questions;
}

function normalizeQuestionOptions(
  value: unknown,
): readonly { readonly label: string; readonly description?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: { label: string; description?: string }[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const label = stringField(item, 'label');
    if (label === undefined) return undefined;
    options.push({ label, description: stringField(item, 'description') });
  }
  return options;
}

function normalizeApprovalOptions(
  value: unknown,
): Extract<TUIApprovalDisplay, { kind: 'plan_review' }>['options'] {
  if (!Array.isArray(value)) return undefined;
  const options: { label: string; description: string }[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const label = stringField(item, 'label');
    const description = stringField(item, 'description');
    if (label === undefined || description === undefined) return undefined;
    options.push({ label, description });
  }
  return options;
}

function normalizeTodoItems(
  value: unknown,
): Extract<TUIApprovalDisplay, { kind: 'todo_list' }>['items'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: { title: string; status: string }[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const title = stringField(item, 'title');
    const status = stringField(item, 'status');
    if (title === undefined || status === undefined) return undefined;
    items.push({ title, status });
  }
  return items;
}

function normalizeApprovalResponse(value: unknown): TUIApprovalResponse | undefined {
  if (!isRecord(value)) return undefined;
  const decision = value['decision'];
  if (decision !== 'approved' && decision !== 'rejected' && decision !== 'cancelled') {
    return undefined;
  }
  return {
    decision,
    scope: value['scope'] === 'session' ? 'session' : undefined,
    feedback: stringField(value, 'feedback'),
    selectedLabel: stringField(value, 'selectedLabel'),
  };
}

type NormalizedQuestionResult =
  | { readonly valid: false }
  | { readonly valid: true; readonly result: TUIQuestionResult };

function normalizeQuestionResult(value: unknown): NormalizedQuestionResult {
  if (value === null) return { valid: true, result: null };
  if (!isRecord(value)) return { valid: false };
  if (isRecord(value['answers'])) {
    const answers = normalizeQuestionAnswers(value['answers']);
    const method = value['method'];
    if (
      answers === undefined ||
      (method !== undefined &&
        method !== 'enter' &&
        method !== 'space' &&
        method !== 'number_key')
    ) {
      return { valid: false };
    }
    return { valid: true, result: { answers, method } };
  }
  const answers = normalizeQuestionAnswers(value);
  return answers === undefined
    ? { valid: false }
    : { valid: true, result: answers };
}

function normalizeQuestionAnswers(
  value: unknown,
): Record<string, string | true> | undefined {
  if (!isRecord(value)) return undefined;
  const answers: Record<string, string | true> = {};
  for (const [question, answer] of Object.entries(value)) {
    if (typeof answer !== 'string' && answer !== true) return undefined;
    answers[question] = answer;
  }
  return answers;
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

function copyQuestionResult(result: TUIQuestionResult): TUIQuestionResult {
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
  if (!isRecord(value)) return undefined;
  const copied: Record<string, TUIWireValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const copiedItem = copyWireValue(item);
    if (copiedItem !== undefined) copied[key] = copiedItem;
  }
  return copied;
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

function booleanField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const field = value[key];
  return typeof field === 'boolean' ? field : undefined;
}

function isFileOperation(
  value: unknown,
): value is Extract<TUIApprovalDisplay, { kind: 'file_io' }>['operation'] {
  return (
    value === 'read' ||
    value === 'write' ||
    value === 'edit' ||
    value === 'glob' ||
    value === 'grep'
  );
}
