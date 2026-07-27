/**
 * Scenario: session facts, agent facts, replay, and interaction responses cross
 * separate TUI runtime ports. Responsibilities: legacy ports share one
 * session broker, Klient ports bind the correct scope, and both tear down on
 * the last listener. Each runtime facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-events-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  ApprovalHandler,
  ApprovalRequest as LegacyApprovalRequest,
  ApprovalResponse as LegacyApprovalResponse,
  Event,
  QuestionHandler,
  QuestionRequest as LegacyQuestionRequest,
  QuestionResult as LegacyQuestionResult,
  Session,
} from '@moonshot-ai/kimi-code-sdk';

import { createKlientAgentEventsPort } from '#/tui/runtime/klient-agent-events-adapter';
import {
  createKlientSessionEventsPort,
  createKlientSessionScopedEventsPort,
} from '#/tui/runtime/klient-session-events-adapter';
import { createLegacyAgentEventsPort } from '#/tui/runtime/legacy-agent-events-adapter';
import {
  createLegacySessionEventsPort,
  createLegacySessionScopedEventsPort,
} from '#/tui/runtime/legacy-session-events-adapter';
import type { TUIAgentEvent } from '#/tui/runtime/agent-events-port';
import type {
  TUIApprovalResponse,
  TUIQuestionResult,
  TUISessionEvent,
  TUISessionScopedEvent,
} from '#/tui/runtime/session-events-port';

describe('legacy event ports (shared session broker)', () => {
  it('routes session and two agent scopes when all listen, installing one legacy stream', () => {
    const runtime = legacyRuntime();
    const sessionEvents: TUISessionScopedEvent[] = [];
    const firstAgentEvents: TUIAgentEvent[] = [];
    const secondAgentEvents: TUIAgentEvent[] = [];

    createLegacySessionScopedEventsPort(runtime.session).subscribe((event) =>
      sessionEvents.push(event),
    );
    createLegacyAgentEventsPort(runtime.session, 'first').subscribe((event) =>
      firstAgentEvents.push(event),
    );
    createLegacyAgentEventsPort(runtime.session, 'second').subscribe((event) =>
      secondAgentEvents.push(event),
    );
    runtime.emit({
      type: 'session.meta.updated',
      sessionId: 'session-1',
      agentId: 'main',
      title: 'Example session',
      patch: { archived: false },
    });
    runtime.emit({
      type: 'assistant.delta',
      sessionId: 'session-1',
      agentId: 'first',
      turnId: 3,
      delta: 'first reply',
    });
    runtime.emit({
      type: 'assistant.delta',
      sessionId: 'session-1',
      agentId: 'second',
      turnId: 4,
      delta: 'second reply',
    });
    runtime.emit({
      type: 'expert_team.updated',
      sessionId: 'session-1',
      agentId: 'main',
      status: null,
    });

    expect(runtime.session.onEvent).toHaveBeenCalledOnce();
    expect(runtime.setApprovalHandler).toHaveBeenCalledOnce();
    expect(runtime.setQuestionHandler).toHaveBeenCalledOnce();
    expect(sessionEvents).toEqual([
      {
        type: 'session.metadata.changed',
        sessionId: 'session-1',
        changed: ['archived', 'title'],
        title: 'Example session',
        patch: { archived: false },
      },
      {
        type: 'session.expert-team.changed',
        sessionId: 'session-1',
        snapshot: null,
      },
    ]);
    expect(firstAgentEvents).toEqual([
      {
        type: 'assistant.delta',
        sessionId: 'session-1',
        agentId: 'first',
        turnId: 3,
        delta: 'first reply',
      },
    ]);
    expect(secondAgentEvents).toEqual([
      {
        type: 'assistant.delta',
        sessionId: 'session-1',
        agentId: 'second',
        turnId: 4,
        delta: 'second reply',
      },
    ]);
  });

  it('keeps the legacy combined compatibility factory on the shared broker', () => {
    const runtime = legacyRuntime();
    const events: TUISessionEvent[] = [];
    createLegacySessionEventsPort(runtime.session).subscribe((event) =>
      events.push(event),
    );

    runtime.emit({
      type: 'session.meta.updated',
      sessionId: 'session-1',
      agentId: 'main',
      title: 'Combined session',
    });
    runtime.emit({
      type: 'assistant.delta',
      sessionId: 'session-1',
      agentId: 'worker',
      turnId: 2,
      delta: 'combined reply',
    });

    expect(runtime.session.onEvent).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      'session.metadata.changed',
      'assistant.delta',
    ]);
  });

  it('keeps the legacy stream until the last same-agent listener unsubscribes', () => {
    const runtime = legacyRuntime();
    const port = createLegacyAgentEventsPort(runtime.session, 'worker');
    const first = port.subscribe(vi.fn());
    const second = port.subscribe(vi.fn());

    first();
    first();

    expect(runtime.unsubscribeEvents).not.toHaveBeenCalled();
    expect(runtime.setApprovalHandler).not.toHaveBeenCalledWith(undefined);

    second();
    second();

    expect(runtime.unsubscribeEvents).toHaveBeenCalledOnce();
    expect(runtime.setApprovalHandler).toHaveBeenLastCalledWith(undefined);
    expect(runtime.setQuestionHandler).toHaveBeenLastCalledWith(undefined);
  });

  it('reads replay from the agent scope fixed when the legacy port is created', async () => {
    const message = {
      role: 'user',
      content: [{ type: 'text', text: 'review this' }],
      toolCalls: [],
    };
    const runtime = legacyRuntime({
      resumeState: {
        agents: {
          reviewer: replaySource([message]),
        },
        warning: 'Recovered partial state',
      },
    });
    const port = createLegacyAgentEventsPort(runtime.session, 'reviewer');

    const replay = await port.readReplay();

    expect(port.sessionId).toBe('session-1');
    expect(port.agentId).toBe('reviewer');
    expect(replay?.context.history[0]).not.toBe(message);
    expect(replay).toEqual(tuiReplaySnapshot(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: 'review this' }],
          toolCalls: [],
        },
      ],
      'Recovered partial state',
    ));
  });

  it('resolves a legacy approval when the session port responds by interaction id', async () => {
    const runtime = legacyRuntime();
    const events: TUISessionScopedEvent[] = [];
    const port = createLegacySessionScopedEventsPort(runtime.session);
    port.subscribe((event) => events.push(event));
    const response = { decision: 'approved' as const, scope: 'session' as const };
    const request: LegacyApprovalRequest = {
      turnId: 4,
      toolCallId: 'tool-1',
      toolName: 'WriteFile',
      action: 'write example.test',
      display: {
        kind: 'generic',
        summary: 'Write a file',
        detail: { path: 'example.test', content: 'hello' },
      },
    };
    const pending = runtime.requestApproval(request);

    await port.respondToApproval('tool-1', response);

    await expect(pending).resolves.toEqual(response);
    expect(events[0]).toEqual({
      type: 'interaction.requested',
      interaction: {
        id: 'tool-1',
        kind: 'approval',
        sessionId: 'session-1',
        agentId: 'main',
        turnId: 4,
        request: {
          turnId: 4,
          toolCallId: 'tool-1',
          toolName: 'WriteFile',
          action: 'write example.test',
          display: {
            kind: 'generic',
            summary: 'Write a file',
            detail: { path: 'example.test', content: 'hello' },
          },
        },
      },
    });
    if (
      events[0]?.type !== 'interaction.requested' ||
      events[0].interaction.kind !== 'approval'
    ) {
      throw new Error('expected approval interaction');
    }
    expect(events[0].interaction.request).not.toBe(request);
    expect(events[0].interaction.request.display).not.toBe(request.display);
    expect(events[1]).toEqual({
      type: 'interaction.resolved',
      id: 'tool-1',
      sessionId: 'session-1',
      kind: 'approval',
      response,
    });
  });

  it('resolves a legacy question when the session port responds by interaction id', async () => {
    const runtime = legacyRuntime();
    const events: TUISessionScopedEvent[] = [];
    const port = createLegacySessionScopedEventsPort(runtime.session);
    port.subscribe((event) => events.push(event));
    const result = {
      answers: { Environment: 'Test' },
      method: 'space' as const,
    };
    const request: LegacyQuestionRequest = {
      toolCallId: 'question-1',
      questions: [
        {
          question: 'Environment',
          header: 'Target',
          body: 'Choose where to run',
          options: [{ label: 'Test', description: 'Use fixtures' }],
          multiSelect: true,
          otherLabel: 'Other',
          otherDescription: 'Enter a custom target',
        },
      ],
    };
    const pending = runtime.requestQuestion(request);

    await port.respondToQuestion('question-1', result);

    await expect(pending).resolves.toEqual(result);
    expect(events[0]).toEqual({
      type: 'interaction.requested',
      interaction: {
        id: 'question-1',
        kind: 'question',
        sessionId: 'session-1',
        agentId: 'main',
        request: {
          turnId: undefined,
          toolCallId: 'question-1',
          questions: [
            {
              question: 'Environment',
              header: 'Target',
              body: 'Choose where to run',
              options: [{ label: 'Test', description: 'Use fixtures' }],
              multiSelect: true,
              otherLabel: 'Other',
              otherDescription: 'Enter a custom target',
            },
          ],
        },
      },
    });
    if (
      events[0]?.type !== 'interaction.requested' ||
      events[0].interaction.kind !== 'question'
    ) {
      throw new Error('expected question interaction');
    }
    expect(events[0].interaction.request).not.toBe(request);
    expect(events[0].interaction.request.questions[0]).not.toBe(request.questions[0]);
    expect(events[0].interaction.request.questions[0]?.options[0]).not.toBe(
      request.questions[0]?.options[0],
    );
    expect(events[1]).toMatchObject({
      type: 'interaction.resolved',
      id: 'question-1',
      kind: 'question',
      response: result,
    });
  });
});

describe('Klient event ports (independent scoped streams)', () => {
  it('shares one session stream across listeners and lists pending interactions once', () => {
    const runtime = klientRuntime();
    const port = createKlientSessionScopedEventsPort(
      runtime.sessionFacade,
      'session-2',
    );
    const firstEvents: TUISessionScopedEvent[] = [];
    const secondEvents: TUISessionScopedEvent[] = [];

    port.subscribe((event) => firstEvents.push(event));
    port.subscribe((event) => secondEvents.push(event));
    runtime.sessionEvents.emit('metadata.changed', { changed: ['updatedAt'] });
    runtime.sessionEvents.emit('expert-team.changed', null);

    expect(runtime.listInteractions).toHaveBeenCalledOnce();
    expect(runtime.sessionEvents.listenerCount('metadata.changed')).toBe(1);
    expect(firstEvents).toEqual([
      {
        type: 'session.metadata.changed',
        sessionId: 'session-2',
        changed: ['updatedAt'],
      },
      {
        type: 'session.expert-team.changed',
        sessionId: 'session-2',
        snapshot: null,
      },
    ]);
    expect(secondEvents).toEqual(firstEvents);
  });

  it('resolves the current title when Klient reports title metadata changed', async () => {
    const runtime = klientRuntime();
    const events: TUISessionScopedEvent[] = [];
    createKlientSessionScopedEventsPort(
      runtime.sessionFacade,
      'session-2',
    ).subscribe((event) => events.push(event));

    runtime.sessionEvents.emit('metadata.changed', { changed: ['title'] });
    await Promise.resolve();

    expect(runtime.getSession).toHaveBeenCalledOnce();
    expect(events).toEqual([
      {
        type: 'session.metadata.changed',
        sessionId: 'session-2',
        changed: ['title'],
        title: 'Renamed session',
      },
    ]);
  });

  it('projects Klient expert-team changes into the runtime-neutral snapshot', () => {
    const runtime = klientRuntime();
    const events: TUISessionScopedEvent[] = [];
    createKlientSessionScopedEventsPort(
      runtime.sessionFacade,
      'session-2',
    ).subscribe((event) => events.push(event));
    const member = {
      name: 'engineer',
      agentId: 'agent-engineer',
      profileName: 'expert:engineer',
      status: 'spawning' as const,
      updatedAt: '2026-07-27T02:02:00.000Z',
    };

    runtime.sessionEvents.emit('expert-team.changed', {
      binding: {
        pluginId: 'software-company',
        pluginVersion: '1.0.0',
        displayName: 'Software Company',
        leadAgentName: 'team-lead',
        leadProfileName: 'expert:team-lead',
        memberAgentNames: ['engineer'],
        previousProfile: {
          cwd: '/workspace',
          thinkingLevel: 'off',
          systemPrompt: 'Example system prompt',
        },
        activatedAt: '2026-07-27T02:00:00.000Z',
      },
      team: {
        id: 'team-1',
        name: 'Software Company',
        createdAt: '2026-07-27T02:01:00.000Z',
        members: [member],
      },
    });

    expect(events).toEqual([
      {
        type: 'session.expert-team.changed',
        sessionId: 'session-2',
        snapshot: {
          pluginId: 'software-company',
          pluginVersion: '1.0.0',
          displayName: 'Software Company',
          leadAgentName: 'team-lead',
          activatedAt: '2026-07-27T02:00:00.000Z',
          members: [
            {
              name: 'engineer',
              agentId: 'agent-engineer',
              status: 'spawning',
            },
          ],
        },
      },
    ]);
    if (events[0]?.type !== 'session.expert-team.changed') {
      throw new Error('expected expert-team event');
    }
    expect(events[0].snapshot?.members?.[0]).not.toBe(member);
  });

  it('keeps the Klient combined compatibility factory on one session stream', () => {
    const runtime = klientRuntime();
    const events: TUISessionEvent[] = [];
    createKlientSessionEventsPort(
      runtime.sessionFacade,
      'session-2',
      'worker',
    ).subscribe((event) => events.push(event));

    runtime.sessionEvents.emit('metadata.changed', { changed: ['updatedAt'] });
    runtime.agentEvents('worker').emit('assistant.delta', {
      type: 'assistant.delta',
      turnId: 3,
      delta: 'combined reply',
    });

    expect(runtime.sessionEvents.listenerCount('metadata.changed')).toBe(1);
    expect(runtime.listInteractions).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual([
      'session.metadata.changed',
      'assistant.delta',
    ]);
  });

  it('routes two Klient agent streams independently without session subscriptions', () => {
    const runtime = klientRuntime();
    const firstEvents: TUIAgentEvent[] = [];
    const secondEvents: TUIAgentEvent[] = [];

    createKlientAgentEventsPort(runtime.sessionFacade, 'session-2', 'first').subscribe(
      (event) => firstEvents.push(event),
    );
    createKlientAgentEventsPort(runtime.sessionFacade, 'session-2', 'second').subscribe(
      (event) => secondEvents.push(event),
    );
    runtime.agentEvents('first').emit('assistant.delta', {
      type: 'assistant.delta',
      turnId: 8,
      delta: 'first reply',
    });
    runtime.agentEvents('second').emit('warning', {
      type: 'warning',
      message: 'second warning',
    });

    expect(runtime.sessionEvents.listenerCount()).toBe(0);
    expect(runtime.listInteractions).not.toHaveBeenCalled();
    expect(firstEvents).toEqual([
      {
        type: 'assistant.delta',
        sessionId: 'session-2',
        agentId: 'first',
        turnId: 8,
        delta: 'first reply',
      },
    ]);
    expect(secondEvents).toEqual([
      {
        type: 'warning',
        sessionId: 'session-2',
        agentId: 'second',
        message: 'second warning',
      },
    ]);
  });

  it('keeps a Klient agent stream until the last listener unsubscribes', () => {
    const runtime = klientRuntime();
    const port = createKlientAgentEventsPort(runtime.sessionFacade, 'session-2', 'worker');
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const first = port.subscribe(firstListener);
    const second = port.subscribe(secondListener);

    first();
    first();
    runtime.agentEvents('worker').emit('assistant.delta', {
      type: 'assistant.delta',
      turnId: 9,
      delta: 'still connected',
    });

    expect(runtime.agentEvents('worker').listenerCount('assistant.delta')).toBe(1);
    expect(firstListener).not.toHaveBeenCalled();
    expect(secondListener).toHaveBeenCalledOnce();

    second();
    second();

    expect(runtime.agentEvents('worker').listenerCount()).toBe(0);
  });

  it('normalizes Klient task lifecycle names for the TUI agent contract', () => {
    const runtime = klientRuntime();
    const events: TUIAgentEvent[] = [];
    createKlientAgentEventsPort(runtime.sessionFacade, 'session-2', 'worker').subscribe(
      (event) => events.push(event),
    );
    const task = {
      taskId: 'task-1',
      kind: 'agent',
      description: 'Review',
      status: 'running',
      startedAt: 1,
      endedAt: null,
    };

    runtime.agentEvents('worker').emit('task.started', {
      type: 'task.started',
      info: task,
    });
    runtime.agentEvents('worker').emit('task.terminated', {
      type: 'task.terminated',
      info: { ...task, status: 'completed', endedAt: 2 },
    });

    expect(events).toEqual([
      {
        type: 'background.task.started',
        sessionId: 'session-2',
        agentId: 'worker',
        info: task,
      },
      {
        type: 'background.task.terminated',
        sessionId: 'session-2',
        agentId: 'worker',
        info: { ...task, status: 'completed', endedAt: 2 },
      },
    ]);
  });

  it('reads replay from the agent scope fixed when the Klient port is created', async () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'reviewed' }],
      toolCalls: [],
    };
    const runtime = klientRuntime({
      history: {
        reviewer: [message],
      },
    });
    const port = createKlientAgentEventsPort(
      runtime.sessionFacade,
      'session-2',
      'reviewer',
    );

    const replay = await port.readReplay();

    expect(port.sessionId).toBe('session-2');
    expect(port.agentId).toBe('reviewer');
    expect(replay?.context.history[0]).not.toBe(message);
    expect(replay).toEqual(tuiReplaySnapshot([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'reviewed' }],
        toolCalls: [],
      },
    ]));
  });

  it('routes a Klient approval response through the session facade', async () => {
    const runtime = klientRuntime();
    const port = createKlientSessionScopedEventsPort(
      runtime.sessionFacade,
      'session-2',
    );
    const response = { decision: 'approved' as const };

    await port.respondToApproval('approval-1', response);

    expect(runtime.decideApproval).toHaveBeenCalledWith('approval-1', response);
    expect(runtime.decideApproval.mock.calls[0]?.[1]).not.toBe(response);
  });

  it('routes a Klient question response through the session facade', async () => {
    const runtime = klientRuntime();
    const port = createKlientSessionScopedEventsPort(
      runtime.sessionFacade,
      'session-2',
    );
    const result = {
      answers: { Choice: 'A' },
      method: 'number_key' as const,
    };

    await port.respondToQuestion('question-1', result);

    expect(runtime.answerQuestion).toHaveBeenCalledWith('question-1', result);
    const forwarded = runtime.answerQuestion.mock.calls[0]?.[1];
    expect(forwarded).not.toBe(result);
    if (
      forwarded === undefined ||
      forwarded === null ||
      typeof forwarded['answers'] !== 'object' ||
      forwarded['answers'] === null
    ) {
      throw new Error('expected structured question response');
    }
    expect(forwarded['answers']).not.toBe(result.answers);
  });

  it('maps Klient interaction changes and resolutions through the session stream', () => {
    const runtime = klientRuntime();
    const events: TUISessionScopedEvent[] = [];
    const port = createKlientSessionScopedEventsPort(
      runtime.sessionFacade,
      'session-2',
    );
    port.subscribe((event) => events.push(event));
    const display = {
      kind: 'generic',
      summary: 'Write a file',
      detail: { path: 'example.test' },
    };
    runtime.sessionEvents.emit('interactions.changed', [
      {
        id: 'approval-1',
        kind: 'approval',
        payload: {
          toolName: 'WriteFile',
          action: 'write example.test',
          display,
        },
        origin: { agentId: 'reviewer', turnId: 5 },
        createdAt: 10,
      },
    ]);

    runtime.sessionEvents.emit('interactions.resolved', {
      id: 'approval-1',
      response: { decision: 'approved' },
    });

    expect(events[0]).toEqual({
      type: 'interaction.requested',
      interaction: {
        id: 'approval-1',
        kind: 'approval',
        sessionId: 'session-2',
        agentId: 'reviewer',
        turnId: 5,
        createdAt: 10,
        request: {
          turnId: undefined,
          toolCallId: 'approval-1',
          toolName: 'WriteFile',
          action: 'write example.test',
          display: {
            kind: 'generic',
            summary: 'Write a file',
            detail: { path: 'example.test' },
          },
        },
      },
    });
    if (
      events[0]?.type !== 'interaction.requested' ||
      events[0].interaction.kind !== 'approval'
    ) {
      throw new Error('expected approval interaction');
    }
    expect(events[0].interaction.request.display).not.toBe(display);
    expect(events[1]).toEqual({
      type: 'interaction.resolved',
      id: 'approval-1',
      sessionId: 'session-2',
      kind: 'approval',
      response: { decision: 'approved' },
    });
  });

  it('maps Klient question options and answer methods through the session stream', () => {
    const runtime = klientRuntime();
    const events: TUISessionScopedEvent[] = [];
    const port = createKlientSessionScopedEventsPort(
      runtime.sessionFacade,
      'session-2',
    );
    port.subscribe((event) => events.push(event));
    const option = { label: 'Alpha', description: 'First option' };

    runtime.sessionEvents.emit('interactions.changed', [
      {
        id: 'question-2',
        kind: 'question',
        payload: {
          turnId: 7,
          questions: [
            {
              question: 'Choose?',
              header: 'Pick',
              body: 'Select one or more',
              options: [option],
              multiSelect: true,
              otherLabel: 'Other',
              otherDescription: 'Type a custom answer',
            },
          ],
        },
        origin: { agentId: 'reviewer', turnId: 7 },
        createdAt: 11,
      },
    ]);
    runtime.sessionEvents.emit('interactions.resolved', {
      id: 'question-2',
      response: {
        answers: { 'Choose?': 'Alpha' },
        method: 'space',
      },
    });

    expect(events).toEqual([
      {
        type: 'interaction.requested',
        interaction: {
          id: 'question-2',
          kind: 'question',
          sessionId: 'session-2',
          agentId: 'reviewer',
          turnId: 7,
          createdAt: 11,
          request: {
            turnId: 7,
            toolCallId: undefined,
            questions: [
              {
                question: 'Choose?',
                header: 'Pick',
                body: 'Select one or more',
                options: [{ label: 'Alpha', description: 'First option' }],
                multiSelect: true,
                otherLabel: 'Other',
                otherDescription: 'Type a custom answer',
              },
            ],
          },
        },
      },
      {
        type: 'interaction.resolved',
        id: 'question-2',
        sessionId: 'session-2',
        kind: 'question',
        response: {
          answers: { 'Choose?': 'Alpha' },
          method: 'space',
        },
      },
    ]);
    if (
      events[0]?.type !== 'interaction.requested' ||
      events[0].interaction.kind !== 'question'
    ) {
      throw new Error('expected question interaction');
    }
    expect(events[0].interaction.request.questions[0]?.options[0]).not.toBe(option);
  });
});

function legacyRuntime(options: { resumeState?: unknown } = {}) {
  let eventListener: ((event: Event) => void) | undefined;
  let approvalHandler: ApprovalHandler | undefined;
  let questionHandler: QuestionHandler | undefined;
  const unsubscribeEvents = vi.fn();
  const setApprovalHandler = vi.fn((handler) => {
    approvalHandler = handler;
  });
  const setQuestionHandler = vi.fn((handler) => {
    questionHandler = handler;
  });
  const session = {
    id: 'session-1',
    onEvent: vi.fn((listener) => {
      eventListener = listener;
      return unsubscribeEvents;
    }),
    setApprovalHandler,
    setQuestionHandler,
    getResumeState: vi.fn(
      () => options.resumeState as ReturnType<Session['getResumeState']>,
    ),
  };
  return {
    session,
    unsubscribeEvents,
    setApprovalHandler,
    setQuestionHandler,
    emit: (event: Event) => eventListener?.(event),
    requestApproval: (request: LegacyApprovalRequest) =>
      Promise.resolve(approvalHandler?.(request)) as Promise<LegacyApprovalResponse>,
    requestQuestion: (request: LegacyQuestionRequest) =>
      Promise.resolve(questionHandler?.(request)) as Promise<LegacyQuestionResult>,
  };
}

function klientRuntime(
  options: { history?: Readonly<Record<string, readonly unknown[]>> } = {},
) {
  const sessionEvents = new TestEventHub();
  const agentEventHubs = new Map<string, TestEventHub>();
  const decideApproval = vi.fn(
    async (_id: string, _response: TUIApprovalResponse) => undefined,
  );
  const answerQuestion = vi.fn(
    async (_id: string, _result: TUIQuestionResult) => undefined,
  );
  const listInteractions = vi.fn(async () => []);
  const getSession = vi.fn(async () => ({ title: 'Renamed session' }));
  const agent = vi.fn((agentId: string) => ({
    events: agentEvents(agentId),
    getContext: vi.fn(async () => ({
      history: options.history?.[agentId] ?? [],
      tokenCount: 0,
    })),
    replay: {
      read: vi.fn(async () => replaySource(options.history?.[agentId] ?? [])),
    },
  }));
  const sessionFacade = {
    get: getSession,
    events: sessionEvents,
    agent,
    approvals: {
      list: vi.fn(async () => []),
      decide: decideApproval,
    },
    questions: {
      list: vi.fn(async () => []),
      answer: answerQuestion,
      dismiss: vi.fn(async () => undefined),
    },
    interactions: {
      list: listInteractions,
      respond: vi.fn(async () => undefined),
    },
  } as unknown as Parameters<typeof createKlientSessionEventsPort>[0];

  return {
    sessionFacade,
    sessionEvents,
    agentEvents,
    decideApproval,
    answerQuestion,
    getSession,
    listInteractions,
  };

  function agentEvents(agentId: string): TestEventHub {
    let hub = agentEventHubs.get(agentId);
    if (hub === undefined) {
      hub = new TestEventHub();
      agentEventHubs.set(agentId, hub);
    }
    return hub;
  }
}

function replaySource(history: readonly unknown[]) {
  return {
    type: 'main' as const,
    config: {
      cwd: '/tmp/project',
      modelAlias: 'example-model',
      modelCapabilities: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 128_000,
      },
      thinkingLevel: 'off',
      systemPrompt: 'Example system prompt',
    },
    context: {
      history,
      tokenCount: 0,
    },
    replay: [],
    permission: {
      mode: 'manual' as const,
      rules: [],
    },
    plan: null,
    swarmMode: false,
    usage: {},
    tools: [],
    tasks: [],
    background: [],
  };
}

function tuiReplaySnapshot(
  history: readonly unknown[],
  warning?: string,
) {
  const source = replaySource(history);
  return {
    type: source.type,
    config: {
      ...source.config,
      providerModel: undefined,
    },
    context: source.context,
    replay: [],
    permission: source.permission,
    plan: null,
    swarmMode: false,
    usage: {
      byModel: undefined,
      currentTurn: undefined,
      total: undefined,
    },
    tools: [],
    tasks: [],
    toolStore: undefined,
    warning,
  };
}

class TestEventHub {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, listener: (payload: unknown) => void) {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
    return {
      dispose: () => {
        listeners?.delete(listener);
      },
    };
  }

  onError() {
    return { dispose: () => undefined };
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  listenerCount(event?: string): number {
    if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}
