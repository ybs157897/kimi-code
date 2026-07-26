import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { ContentPart } from '@moonshot-ai/kosong';
import {
  SHUTDOWN_TIMEOUT_MS,
  TEAM_LEAD_ID,
  TEAMMATE_PROMPT_ORIGIN,
  TeamRuntime,
  renderTeammateMessage,
  type ExpertTeamRuntimeState,
  type TeamEnvelope,
} from '../../src/expert-team/runtime';
import type { PromptOrigin } from '../../src/agent/context';
import type { SubagentHandle } from '../../src/session/subagent-host';

interface SteerCall {
  readonly parts: readonly ContentPart[];
  readonly origin: PromptOrigin | undefined;
}

interface FakeMain {
  readonly agent: Agent;
  readonly steers: SteerCall[];
  readonly appends: SteerCall[];
  readonly resumeCalls: Array<{ agentId: string; options: Record<string, unknown> }>;
  readonly registeredTasks: string[];
  readonly suppressedTasks: string[];
  readonly stoppedTasks: Array<{ taskId: string; reason?: string }>;
  resolveResume(result?: string): void;
  resolveResumeCall(index: number, result?: string): void;
  rejectResume(error: Error): void;
  failNextResume(error: Error): void;
  failNextTaskRegistration(error: Error): void;
  settleTask(taskId: string, status?: 'completed' | 'failed' | 'timed_out' | 'killed'): void;
  backgroundList: Array<{ kind: string; agentId?: string; taskId: string }>;
}

function fakeMain(): FakeMain {
  const steers: SteerCall[] = [];
  const appends: SteerCall[] = [];
  const resumeCalls: Array<{ agentId: string; options: Record<string, unknown> }> = [];
  const registeredTasks: string[] = [];
  const suppressedTasks: string[] = [];
  const stoppedTasks: Array<{ taskId: string; reason?: string }> = [];
  const completionResolves: Array<(value: { result: string }) => void> = [];
  const completionRejects: Array<(error: Error) => void> = [];
  const taskTerminalResolves = new Map<
    string,
    (info: { status: 'completed' | 'failed' | 'timed_out' | 'killed' }) => void
  >();
  let resumeStartError: Error | undefined;
  let taskRegistrationError: Error | undefined;

  const context: FakeMain = {
    steers,
    appends,
    resumeCalls,
    registeredTasks,
    suppressedTasks,
    stoppedTasks,
    backgroundList: [],
    resolveResume: (result = 'done') => {
      completionResolves.at(-1)?.({ result });
    },
    resolveResumeCall: (index, result = 'done') => {
      completionResolves[index]?.({ result });
    },
    rejectResume: (error) => {
      completionRejects.at(-1)?.(error);
    },
    failNextResume: (error) => {
      resumeStartError = error;
    },
    failNextTaskRegistration: (error) => {
      taskRegistrationError = error;
    },
    settleTask: (taskId, status = 'completed') => {
      taskTerminalResolves.get(taskId)?.({ status });
    },
    agent: {
      turn: {
        steer: (parts: readonly ContentPart[], origin?: PromptOrigin) => {
          steers.push({ parts, origin });
          return null;
        },
      },
      context: {
        appendUserMessage: (parts: readonly ContentPart[], origin?: PromptOrigin) => {
          appends.push({ parts, origin });
        },
      },
      subagentHost: {
        resume: vi.fn(async (agentId: string, options: Record<string, unknown>) => {
          resumeCalls.push({ agentId, options });
          if (resumeStartError !== undefined) {
            const error = resumeStartError;
            resumeStartError = undefined;
            throw error;
          }
          const completion = new Promise<{ result: string }>((resolve, reject) => {
            completionResolves.push(resolve);
            completionRejects.push(reject);
          });
          // Swallow unhandled rejections from tests that reject the completion.
          void completion.catch(() => {});
          return {
            agentId,
            profileName: 'member-profile',
            resumed: true,
            completion,
          } satisfies SubagentHandle;
        }),
        markActiveChildDetached: vi.fn(),
      },
      background: {
        registerTask: vi.fn(() => {
          if (taskRegistrationError !== undefined) {
            const error = taskRegistrationError;
            taskRegistrationError = undefined;
            throw error;
          }
          const taskId = `task-${registeredTasks.length}`;
          registeredTasks.push(taskId);
          return taskId;
        }),
        suppressTerminalNotification: vi.fn(async (taskId: string) => {
          suppressedTasks.push(taskId);
        }),
        list: vi.fn(() => context.backgroundList),
        waitUntilTerminal: vi.fn(
          (taskId: string) =>
            new Promise((resolve) => {
              taskTerminalResolves.set(taskId, resolve);
            }),
        ),
        stop: vi.fn(async (taskId: string, reason?: string) => {
          stoppedTasks.push({ taskId, reason });
          return undefined;
        }),
      },
      kimiConfig: undefined,
    } as unknown as Agent,
  };
  return context;
}

interface FakeMember {
  hasActiveTurn: boolean;
  readonly steers: SteerCall[];
  agent: Agent;
}

function fakeMember(name: string, runtime: TeamRuntime): FakeMember {
  const steers: SteerCall[] = [];
  const member: FakeMember = {
    hasActiveTurn: false,
    steers,
    agent: undefined as unknown as Agent,
  };
  member.agent = {
    turn: {
      get hasActiveTurn() {
        return member.hasActiveTurn;
      },
      steer: (parts: readonly ContentPart[], origin?: PromptOrigin) => {
        steers.push({ parts, origin });
        return null;
      },
    },
    config: {
      hasProvider: false,
      profileName: name,
      systemPrompt: 'member prompt',
    },
    tools: {
      initializeBuiltinTools: vi.fn(),
      loopTools: [{ name: 'SendMessage' }],
    },
    team: runtime,
    teamSelfName: name,
  } as unknown as Agent;
  return member;
}

interface Harness {
  readonly runtime: TeamRuntime;
  readonly main: FakeMain;
  readonly members: Map<string, FakeMember>;
  readonly persisted: ExpertTeamRuntimeState[];
  addMember(name: string, agentId: string, status?: 'idle' | 'running'): FakeMember;
}

function harness(
  declaredMembers: readonly string[] = ['software-architect', 'reviewer'],
  persistState?: (state: ExpertTeamRuntimeState) => Promise<void>,
): Harness {
  const main = fakeMain();
  const members = new Map<string, FakeMember>();
  const agents = new Map<string, Agent>([['main', main.agent]]);
  const persisted: ExpertTeamRuntimeState[] = [];
  const runtime = new TeamRuntime(
    {
      getReadyAgent: (id) => agents.get(id),
      ensureAgentResumed: async (id) => {
        const agent = agents.get(id);
        if (agent === undefined) throw new Error(`Agent "${id}" was not found`);
        return agent;
      },
    },
    'main',
    declaredMembers,
    async (state) => {
      persisted.push(state);
      await persistState?.(state);
    },
  );
  return {
    runtime,
    main,
    members,
    persisted,
    addMember: (name, agentId, status = 'idle') => {
      const member = fakeMember(name, runtime);
      members.set(name, member);
      agents.set(agentId, member.agent);
      runtime.registerMember(name, agentId);
      runtime.markMemberStatus(name, status);
      return member;
    },
  };
}

function textOf(call: SteerCall): string {
  const part = call.parts[0];
  return part?.type === 'text' ? part.text : '';
}

function controlledHandle(agentId: string): {
  readonly handle: SubagentHandle;
  resolve(result?: string): void;
} {
  let resolveCompletion: (value: { result: string }) => void = () => {};
  const completion = new Promise<{ result: string }>((resolve) => {
    resolveCompletion = resolve;
  });
  return {
    handle: {
      agentId,
      profileName: 'software-architect',
      resumed: false,
      completion,
    },
    resolve: (result = 'done') => {
      resolveCompletion({ result });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('renderTeammateMessage', () => {
  it('renders the teammate-message block with escaped attributes', () => {
    const envelope: TeamEnvelope = {
      id: 'id-1',
      type: 'message',
      from: 'a"b',
      to: TEAM_LEAD_ID,
      summary: 'quo"te & amp',
      text: 'body line',
      sentAt: '2026-01-01T00:00:00.000Z',
    };
    expect(renderTeammateMessage(envelope)).toBe(
      '<teammate-message teammate_id="a&quot;b" summary="quo&quot;te &amp; amp">\nbody line\n</teammate-message>',
    );
  });
});

describe('TeamRuntime send/deliver', () => {
  it('delivers a member message to the lead via turn.steer with the teammate origin', async () => {
    const h = harness();
    h.addMember('software-architect', 'agent-0');

    const result = await h.runtime.send({
      type: 'message',
      from: 'software-architect',
      recipient: TEAM_LEAD_ID,
      summary: 'Architecture draft ready',
      text: 'Full draft content',
    });

    expect(result).toEqual({ ok: true, message: 'Message sent to team-lead.' });
    expect(h.main.steers).toHaveLength(1);
    expect(textOf(h.main.steers[0]!)).toContain(
      '<teammate-message teammate_id="software-architect" summary="Architecture draft ready">',
    );
    expect(textOf(h.main.steers[0]!)).toContain('Full draft content');
    expect(h.main.steers[0]!.origin).toEqual(TEAMMATE_PROMPT_ORIGIN);
    expect(TEAMMATE_PROMPT_ORIGIN).toEqual({ kind: 'system_trigger', name: 'teammate' });
  });

  it('rejects unknown recipients with the known-teammate list', async () => {
    const h = harness();
    h.addMember('software-architect', 'agent-0');

    const result = await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'nonexistent',
      summary: 's',
      text: 'body',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Unknown teammate "nonexistent"');
    expect(result.message).toContain('team-lead');
    expect(result.message).toContain('software-architect');
  });

  it('rejects missing recipient, self-send, and empty message', async () => {
    const h = harness();
    h.addMember('software-architect', 'agent-0');

    await expect(
      h.runtime.send({ type: 'message', from: TEAM_LEAD_ID, summary: 's', text: 'b' }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('recipient is required') });
    await expect(
      h.runtime.send({
        type: 'message',
        from: 'software-architect',
        recipient: 'software-architect',
        summary: 's',
        text: 'b',
      }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('yourself') });
    await expect(
      h.runtime.send({
        type: 'message',
        from: TEAM_LEAD_ID,
        recipient: 'software-architect',
        summary: 's',
      }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('message is required') });
  });

  it('expands a member broadcast to the lead and every other member', async () => {
    const h = harness(['software-architect', 'reviewer', 'tester']);
    h.addMember('software-architect', 'agent-0');
    const reviewer = h.addMember('reviewer', 'agent-1');
    reviewer.hasActiveTurn = true;
    h.members.get('reviewer')!;
    h.runtime.markMemberStatus('reviewer', 'running');
    const tester = h.addMember('tester', 'agent-2');
    tester.hasActiveTurn = true;
    h.runtime.markMemberStatus('tester', 'running');

    const result = await h.runtime.send({
      type: 'broadcast',
      from: 'software-architect',
      summary: 'heads up',
      text: 'broadcast body',
    });

    expect(result).toEqual({ ok: true, message: 'Broadcast sent to 3 teammates.' });
    expect(h.main.steers).toHaveLength(1);
    expect(reviewer.steers).toHaveLength(1);
    expect(tester.steers).toHaveLength(1);
    // The sender itself receives nothing.
    expect(h.members.get('software-architect')!.steers).toHaveLength(0);
  });

  it('steers a running member and wakes an idle member', async () => {
    const h = harness();
    const running = h.addMember('software-architect', 'agent-0', 'running');
    running.hasActiveTurn = true;
    h.addMember('reviewer', 'agent-1', 'idle');

    await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'follow-up',
      text: 'please adjust',
    });
    expect(running.steers).toHaveLength(1);
    expect(textOf(running.steers[0]!)).toContain('please adjust');
    expect(h.main.resumeCalls).toHaveLength(0);

    await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'reviewer',
      summary: 'new task',
      text: 'review this',
    });
    expect(h.main.resumeCalls).toHaveLength(1);
    expect(h.main.resumeCalls[0]).toMatchObject({
      agentId: 'agent-1',
      options: {
        runInBackground: true,
        skipSummaryContinuation: true,
      },
    });
    expect(String(h.main.resumeCalls[0]!.options['prompt'])).toContain(
      '<teammate-message teammate_id="team-lead" summary="new task">',
    );
    expect(h.runtime.memberByName('reviewer')?.status).toBe('running');
    // Wake task registered detached + its terminal notification suppressed.
    expect(h.main.registeredTasks).toHaveLength(1);
    expect(h.main.suppressedTasks).toEqual(h.main.registeredTasks);

    h.main.resolveResume();
    await vi.waitFor(() => {
      expect(h.runtime.memberByName('reviewer')?.status).toBe('idle');
    });
  });

  it('mails the lead when a woken member fails, then flips it back to idle', async () => {
    const h = harness();
    h.addMember('reviewer', 'agent-1', 'idle');

    await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'reviewer',
      summary: 'task',
      text: 'work',
    });
    h.main.rejectResume(new Error('boom'));

    await vi.waitFor(() => {
      expect(h.runtime.memberByName('reviewer')?.status).toBe('idle');
      expect(h.main.steers.length).toBeGreaterThan(0);
    });
    expect(textOf(h.main.steers[0]!)).toContain('Teammate "reviewer" stopped before delivering');
  });

  it('settles a member when its background task terminates before the handle', async () => {
    const h = harness();
    h.addMember('reviewer', 'agent-1', 'idle');

    await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'reviewer',
      summary: 'task',
      text: 'work',
    });
    h.main.settleTask(h.main.registeredTasks[0]!, 'killed');

    await vi.waitFor(() => {
      expect(h.runtime.memberByName('reviewer')?.status).toBe('idle');
      expect(h.main.steers.some((call) => textOf(call).includes('stopped before delivering'))).toBe(
        true,
      );
    });
  });

  it('removes a member whose expert profile failed to configure', async () => {
    const h = harness();
    const member = h.addMember('reviewer', 'agent-1', 'idle');
    member.agent.team = undefined;

    await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'reviewer',
      summary: 'task',
      text: 'work',
    });
    h.main.rejectResume(new Error('profile failed'));

    await vi.waitFor(() => {
      expect(h.runtime.memberByName('reviewer')).toBeUndefined();
      expect(h.main.steers.some((call) => textOf(call).includes('failed to start'))).toBe(true);
    });
  });

  it('rolls an idle member back when wake-up cannot start and can retry the journal', async () => {
    const h = harness();
    h.addMember('reviewer', 'agent-1', 'idle');
    h.main.failNextResume(new Error('resume failed'));

    await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'reviewer',
      summary: 'task',
      text: 'work',
    });

    expect(h.runtime.memberByName('reviewer')?.status).toBe('idle');
    expect(h.runtime.snapshot().journal).toHaveLength(1);

    await h.runtime.replayJournal();
    expect(h.main.resumeCalls).toHaveLength(2);
    expect(h.runtime.memberByName('reviewer')?.status).toBe('running');
    expect(h.runtime.snapshot().journal).toHaveLength(0);
  });

  it('ignores a stale wake completion after task registration failed', async () => {
    const h = harness();
    h.addMember('reviewer', 'agent-1', 'idle');
    h.main.failNextTaskRegistration(new Error('registration failed'));

    await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'reviewer',
      summary: 'task',
      text: 'work',
    });
    expect(h.runtime.memberByName('reviewer')?.status).toBe('idle');

    await h.runtime.replayJournal();
    expect(h.runtime.memberByName('reviewer')?.status).toBe('running');

    h.main.resolveResumeCall(0);
    await Promise.resolve();
    expect(h.runtime.memberByName('reviewer')?.status).toBe('running');

    h.main.resolveResumeCall(1);
    await vi.waitFor(() => {
      expect(h.runtime.memberByName('reviewer')?.status).toBe('idle');
    });
  });

  it('journals mail for a member stuck in a spawn race and replays it on settle', async () => {
    const h = harness();
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = false; // spawned, first turn not active yet

    await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'racing',
      text: 'queued mail',
    });
    expect(member.steers).toHaveLength(0);
    expect(h.main.resumeCalls).toHaveLength(0);
    expect(h.runtime.snapshot().journal).toHaveLength(1);

    // Member settles to idle → replay wakes it with the queued mail.
    h.runtime.markMemberStatus('software-architect', 'idle');
    await h.runtime.replayJournal();
    expect(h.main.resumeCalls).toHaveLength(1);
    expect(String(h.main.resumeCalls[0]!.options['prompt'])).toContain('queued mail');
    expect(h.runtime.snapshot().journal).toHaveLength(0);
  });

  it('rolls back a reserved dispatch cancelled before registration', async () => {
    const h = harness();
    const member = controlledHandle('agent-0');
    const controller = new AbortController();
    expect(h.runtime.tryReserveMember('software-architect')).toBe(true);
    controller.abort(new Error('cancelled'));

    await expect(
      h.runtime.dispatchMember(
        'software-architect',
        member.handle,
        controller,
        'cancelled run',
      ),
    ).rejects.toThrow();

    expect(h.runtime.memberByName('software-architect')).toBeUndefined();
    expect(h.runtime.tryReserveMember('software-architect')).toBe(true);
    h.runtime.releaseMemberReservation('software-architect');
  });

  it('clears a shutdown request when an uncommitted dispatch rolls back', async () => {
    let rejectFirstPersist: (error: Error) => void = () => {};
    let persistCalls = 0;
    const h = harness(undefined, async () => {
      persistCalls += 1;
      if (persistCalls === 1) {
        await new Promise<void>((_resolve, reject) => {
          rejectFirstPersist = reject;
        });
      }
    });
    const member = controlledHandle('agent-0');
    const controller = new AbortController();
    expect(h.runtime.tryReserveMember('software-architect')).toBe(true);
    const dispatch = h.runtime.dispatchMember(
      'software-architect',
      member.handle,
      controller,
      'failing run',
    );
    await vi.waitFor(() => {
      expect(h.runtime.memberByName('software-architect')).toBeDefined();
    });

    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'stop',
    });
    expect(request.ok).toBe(true);
    expect(h.runtime.hasPendingShutdowns()).toBe(true);

    rejectFirstPersist(new Error('persist failed'));
    await expect(dispatch).rejects.toThrow('persist failed');
    expect(h.runtime.hasPendingShutdowns()).toBe(false);
    expect(h.runtime.memberByName('software-architect')).toBeUndefined();
  });

  it('does not register a dispatch after the runtime is disposed mid-flight', async () => {
    const h = harness();
    const member = controlledHandle('agent-0');
    const controller = new AbortController();
    expect(h.runtime.tryReserveMember('software-architect')).toBe(true);

    const dispatch = h.runtime.dispatchMember(
      'software-architect',
      member.handle,
      controller,
      'closing run',
    );
    h.runtime.dispose();

    await expect(dispatch).rejects.toThrow('no longer active');
    expect(h.main.registeredTasks).toHaveLength(0);
  });

  it('does not wake an idle member after the runtime is disposed mid-delivery', async () => {
    const h = harness();
    h.addMember('reviewer', 'agent-1', 'idle');

    const delivery = h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'reviewer',
      summary: 'late',
      text: 'late work',
    });
    h.runtime.dispose();
    await delivery;

    expect(h.main.resumeCalls).toHaveLength(0);
    expect(h.main.registeredTasks).toHaveLength(0);
  });
});

describe('TeamRuntime shutdown handshake', () => {
  it('rolls back a failed shutdown request so the member remains eligible for retry', async () => {
    vi.useFakeTimers();
    let persistAttempts = 0;
    const durablePendingCounts: number[] = [];
    const h = harness(undefined, async (state) => {
      persistAttempts += 1;
      if (persistAttempts <= 2) {
        throw new Error('transient persist failure');
      }
      durablePendingCounts.push(state.pendingShutdowns.length);
    });
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;

    await expect(
      h.runtime.send({
        type: 'shutdown_request',
        from: TEAM_LEAD_ID,
        recipient: 'software-architect',
        summary: 'wrap up',
      }),
    ).rejects.toThrow('transient persist failure');

    expect(h.runtime.hasPendingShutdowns()).toBe(false);
    expect(member.steers).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(durablePendingCounts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + 1);
    expect(h.runtime.memberByName('software-architect')).toBeDefined();

    await expect(
      h.runtime.send({
        type: 'shutdown_request',
        from: TEAM_LEAD_ID,
        recipient: 'software-architect',
        summary: 'retry',
      }),
    ).resolves.toMatchObject({ ok: true });
    h.runtime.dispose();
  });

  it('keeps a durable shutdown pending and journals its delivery only once', async () => {
    let persistAttempts = 0;
    const h = harness(undefined, async () => {
      persistAttempts += 1;
      if (persistAttempts === 2) {
        throw new Error('journal persist failed');
      }
    });
    // A newly dispatched member can be marked running before its first turn
    // becomes steerable, so the shutdown request must wait in the journal.
    h.addMember('software-architect', 'agent-0', 'running');

    await expect(
      h.runtime.send({
        type: 'shutdown_request',
        from: TEAM_LEAD_ID,
        recipient: 'software-architect',
        summary: 'wrap up',
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(h.runtime.hasPendingShutdowns()).toBe(true);
    expect(h.runtime.snapshot().journal).toHaveLength(1);
    expect(h.runtime.snapshot().journal[0]?.type).toBe('shutdown_request');
    h.runtime.dispose();
  });

  it('runs the request → approve flow and removes the member', async () => {
    const h = harness();
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;

    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    expect(request.ok).toBe(true);
    expect(h.runtime.memberByName('software-architect')?.status).toBe('running');
    expect(h.runtime.hasPendingShutdowns()).toBe(true);
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];
    expect(requestId).toBeDefined();
    expect(textOf(member.steers[0]!)).toContain(`request_id: ${requestId}`);

    const response = await h.runtime.send({
      type: 'shutdown_response',
      from: 'software-architect',
      summary: 'done',
      requestId,
      approve: true,
    });
    expect(response.ok).toBe(true);
    expect(h.runtime.memberByName('software-architect')).toBeUndefined();
    expect(h.runtime.hasPendingShutdowns()).toBe(false);
    expect(h.main.steers.some((c) => textOf(c).includes('approved shutdown'))).toBe(true);
  });

  it('keeps the member running and forwards the refusal on approve=false', async () => {
    const h = harness();
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;

    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];

    const response = await h.runtime.send({
      type: 'shutdown_response',
      from: 'software-architect',
      summary: 'not yet',
      text: 'Still verifying the fix.',
      requestId,
      approve: false,
    });
    expect(response.ok).toBe(true);
    expect(h.runtime.memberByName('software-architect')?.status).toBe('running');
    expect(h.main.steers.some((c) => textOf(c).includes('Still verifying the fix.'))).toBe(true);
  });

  it('eventually persists a declined shutdown after transient write failures', async () => {
    vi.useFakeTimers();
    let failuresRemaining = 0;
    let durableState: ExpertTeamRuntimeState | undefined;
    const h = harness(undefined, async (state) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error('transient persist failure');
      }
      durableState = state;
    });
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;
    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];
    expect(durableState?.pendingShutdowns).toHaveLength(1);

    failuresRemaining = 2;
    await expect(
      h.runtime.send({
        type: 'shutdown_response',
        from: 'software-architect',
        summary: 'not yet',
        requestId,
        approve: false,
      }),
    ).rejects.toThrow('transient persist failure');

    expect(h.runtime.hasPendingShutdowns()).toBe(false);
    expect(durableState?.pendingShutdowns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(durableState?.pendingShutdowns).toHaveLength(0);
    h.runtime.dispose();
  });

  it('wakes an idle member to handle a shutdown request', async () => {
    const h = harness();
    h.addMember('software-architect', 'agent-0', 'idle');

    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });

    expect(request.ok).toBe(true);
    expect(h.main.resumeCalls).toHaveLength(1);
    expect(String(h.main.resumeCalls[0]!.options['prompt'])).toContain('Shutdown requested');
    expect(h.runtime.memberByName('software-architect')?.status).toBe('running');
    h.runtime.dispose();
  });

  it('allows only the requested member to approve shutdown', async () => {
    const h = harness();
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;
    h.addMember('reviewer', 'agent-1', 'idle');
    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];

    const response = await h.runtime.send({
      type: 'shutdown_response',
      from: 'reviewer',
      summary: 'spoofed',
      requestId,
      approve: true,
    });

    expect(response).toMatchObject({
      ok: false,
      message: expect.stringContaining('belongs to software-architect'),
    });
    expect(h.runtime.memberByName('software-architect')).toBeDefined();
    expect(h.runtime.hasPendingShutdowns()).toBe(true);
    h.runtime.dispose();
  });

  it('rejects messages from a member after it leaves the roster', async () => {
    const h = harness();
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;
    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];
    await h.runtime.send({
      type: 'shutdown_response',
      from: 'software-architect',
      summary: 'done',
      requestId,
      approve: true,
    });

    await expect(
      h.runtime.send({
        type: 'message',
        from: 'software-architect',
        recipient: TEAM_LEAD_ID,
        summary: 'late',
        text: 'late result',
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('no longer active'),
    });
  });

  it('rejects a second pending shutdown request for the same member', async () => {
    const h = harness();
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;
    await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });

    const duplicate = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'again',
    });

    expect(duplicate).toMatchObject({
      ok: false,
      message: expect.stringContaining('already pending'),
    });
    h.runtime.dispose();
  });

  it('rejects shutdown_request from a member and unknown request ids', async () => {
    const h = harness();
    h.addMember('software-architect', 'agent-0');

    await expect(
      h.runtime.send({
        type: 'shutdown_request',
        from: 'software-architect',
        recipient: 'software-architect',
        summary: 's',
      }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Only the team-lead') });
    await expect(
      h.runtime.send({
        type: 'shutdown_response',
        from: 'software-architect',
        summary: 's',
        requestId: 'nope',
        approve: true,
      }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Unknown shutdown request_id') });
    await expect(
      h.runtime.send({
        type: 'shutdown_response',
        from: 'software-architect',
        summary: 's',
        requestId: 'nope',
      }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('approve is required') });
  });

  it('force-stops the member and mails the lead when the request times out', async () => {
    vi.useFakeTimers();
    const h = harness();
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;
    h.main.backgroundList = [{ kind: 'agent', agentId: 'agent-0', taskId: 'task-live' }];

    await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + 1);

    expect(h.runtime.memberByName('software-architect')).toBeUndefined();
    expect(h.runtime.hasPendingShutdowns()).toBe(false);
    expect(h.main.stoppedTasks).toContainEqual({
      taskId: 'task-live',
      reason: 'Expert team member shut down',
    });
    expect(h.main.steers.some((c) => textOf(c).includes('force-stopped'))).toBe(true);
  });

  it('keeps the removal gate after approved shutdown persistence fails, then releases it on retry', async () => {
    vi.useFakeTimers();
    let failNextPersist = false;
    let failedAttempts = 0;
    const h = harness(undefined, async () => {
      if (failNextPersist) {
        failNextPersist = false;
        failedAttempts += 1;
        throw new Error('transient persist failure');
      }
    });
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;
    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];
    failNextPersist = true;

    await expect(
      h.runtime.send({
        type: 'shutdown_response',
        from: 'software-architect',
        summary: 'done',
        requestId,
        approve: true,
      }),
    ).rejects.toThrow('transient persist failure');

    expect(failedAttempts).toBe(1);
    expect(h.runtime.memberByName('software-architect')).toBeUndefined();
    expect(h.runtime.hasActiveMembers()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.runtime.hasActiveMembers()).toBe(false);
  });

  it('keeps the removal gate when journal replay persistence fails, then releases it on retry', async () => {
    vi.useFakeTimers();
    let persistCalls = 0;
    let failAt = Number.POSITIVE_INFINITY;
    const h = harness(undefined, async () => {
      persistCalls += 1;
      if (persistCalls === failAt) {
        throw new Error('replay persist failure');
      }
    });
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = false;
    await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'queued work',
      text: 'finish this first',
    });
    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];
    failAt = persistCalls + 2;

    await expect(
      h.runtime.send({
        type: 'shutdown_response',
        from: 'software-architect',
        summary: 'done',
        requestId,
        approve: true,
      }),
    ).rejects.toThrow('replay persist failure');

    expect(h.runtime.snapshot().journal).toHaveLength(0);
    expect(h.runtime.hasActiveMembers()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.runtime.hasActiveMembers()).toBe(false);
  });

  it('keeps the retiring gate after settlement persistence fails, then releases it on retry', async () => {
    vi.useFakeTimers();
    let failNextPersist = false;
    let failedAttempts = 0;
    const h = harness(undefined, async () => {
      if (failNextPersist) {
        failNextPersist = false;
        failedAttempts += 1;
        throw new Error('transient persist failure');
      }
    });
    const controlled = controlledHandle('agent-0');
    await h.runtime.dispatchMember(
      'software-architect',
      controlled.handle,
      new AbortController(),
      'team task',
    );
    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];
    await h.runtime.send({
      type: 'shutdown_response',
      from: 'software-architect',
      summary: 'done',
      requestId,
      approve: true,
    });
    failNextPersist = true;

    controlled.resolve();
    await vi.waitFor(() => {
      expect(failedAttempts).toBe(1);
    });
    expect(h.runtime.hasActiveMembers()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.runtime.hasActiveMembers()).toBe(false);
  });

  it('retries an unusable member removal until its absence is durable', async () => {
    vi.useFakeTimers();
    let failNextPersist = false;
    let failedAttempts = 0;
    const h = harness(undefined, async () => {
      if (failNextPersist) {
        failNextPersist = false;
        failedAttempts += 1;
        throw new Error('transient persist failure');
      }
    });
    const member = h.addMember('reviewer', 'agent-1', 'idle');
    member.agent.team = undefined;
    await h.runtime.send({
      type: 'message',
      from: TEAM_LEAD_ID,
      recipient: 'reviewer',
      summary: 'task',
      text: 'work',
    });
    failNextPersist = true;

    h.main.rejectResume(new Error('profile failed'));
    await vi.waitFor(() => {
      expect(failedAttempts).toBe(1);
    });
    expect(h.runtime.memberByName('reviewer')).toBeUndefined();
    expect(h.runtime.hasActiveMembers()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.runtime.hasActiveMembers()).toBe(false);
  });

  it('keeps a force-stopped member gated until retry persists the removal', async () => {
    vi.useFakeTimers();
    let failNextPersist = false;
    let failedAttempts = 0;
    const h = harness(undefined, async () => {
      if (failNextPersist) {
        failNextPersist = false;
        failedAttempts += 1;
        throw new Error('transient persist failure');
      }
    });
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;
    await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    failNextPersist = true;

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + 1);
    expect(failedAttempts).toBe(1);
    expect(h.runtime.memberByName('software-architect')).toBeUndefined();
    expect(h.runtime.hasActiveMembers()).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.runtime.hasActiveMembers()).toBe(false);
  });

  it('clears a pending durability retry timer when disposed', async () => {
    vi.useFakeTimers();
    let failNextPersist = false;
    const h = harness(undefined, async () => {
      if (failNextPersist) {
        failNextPersist = false;
        throw new Error('transient persist failure');
      }
    });
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;
    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];
    failNextPersist = true;
    await expect(
      h.runtime.send({
        type: 'shutdown_response',
        from: 'software-architect',
        summary: 'done',
        requestId,
        approve: true,
      }),
    ).rejects.toThrow('transient persist failure');
    expect(vi.getTimerCount()).toBe(1);

    h.runtime.dispose();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let an old member completion erase a replacement task', async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = controlledHandle('agent-0');
    await h.runtime.dispatchMember(
      'software-architect',
      first.handle,
      new AbortController(),
      'first run',
    );
    await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'replace',
    });
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS + 1);

    const second = controlledHandle('agent-1');
    await h.runtime.dispatchMember(
      'software-architect',
      second.handle,
      new AbortController(),
      'second run',
    );
    first.resolve();
    await Promise.resolve();

    const request = await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'finish',
    });
    const requestId = /request_id: ([0-9a-f-]+)/.exec(request.message)?.[1];
    await h.runtime.send({
      type: 'shutdown_response',
      from: 'software-architect',
      summary: 'done',
      requestId,
      approve: true,
    });

    expect(h.runtime.hasActiveMembers()).toBe(true);
    second.resolve();
    await vi.waitFor(() => {
      expect(h.runtime.hasActiveMembers()).toBe(false);
    });
  });
});

describe('TeamRuntime persistence and restore', () => {
  it('snapshots roster, pending shutdowns, and journal', async () => {
    const h = harness();
    const member = h.addMember('software-architect', 'agent-0', 'running');
    member.hasActiveTurn = true;
    await h.runtime.send({
      type: 'shutdown_request',
      from: TEAM_LEAD_ID,
      recipient: 'software-architect',
      summary: 'wrap up',
    });

    const state = h.runtime.snapshot();
    expect(state.members).toEqual([{ name: 'software-architect', agentId: 'agent-0' }]);
    expect(state.pendingShutdowns).toHaveLength(1);
    expect(state.pendingShutdowns[0]).toMatchObject({ member: 'software-architect' });
    expect(h.persisted.length).toBeGreaterThan(0);
    h.runtime.dispose();
  });

  it('restores members as idle, drops missing agents, and replays journal by append', async () => {
    const h = harness();
    const state: ExpertTeamRuntimeState = {
      members: [
        { name: 'software-architect', agentId: 'agent-0' },
        { name: 'reviewer', agentId: 'agent-missing' },
      ],
      pendingShutdowns: [],
      journal: [
        {
          id: 'env-1',
          type: 'message',
          from: 'software-architect',
          to: TEAM_LEAD_ID,
          summary: 'undelivered',
          text: 'result body',
          sentAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    h.runtime.restoreState(state);
    h.runtime.dropMissingMembers((_name, agentId) => agentId === 'agent-0');
    expect(h.runtime.memberByName('software-architect')?.status).toBe('idle');
    expect(h.runtime.memberByName('reviewer')).toBeUndefined();
    expect(h.runtime.hasActiveMembers()).toBe(true);

    await h.runtime.replayJournal({ append: true });
    expect(h.main.steers).toHaveLength(0);
    expect(h.main.appends).toHaveLength(1);
    expect(textOf(h.main.appends[0]!)).toContain('result body');
    expect(h.main.appends[0]!.origin).toEqual(TEAMMATE_PROMPT_ORIGIN);
  });

  it('resolves restored pending shutdowns as journaled force-stop mail', async () => {
    const h = harness();
    h.runtime.restoreState({
      members: [{ name: 'software-architect', agentId: 'agent-0' }],
      pendingShutdowns: [],
      journal: [],
    });

    await h.runtime.resolveRestoredShutdownsByTimeout(['software-architect']);
    expect(h.runtime.memberByName('software-architect')).toBeUndefined();
    // Nothing steered; the notice waits in the journal for an append replay.
    expect(h.main.steers).toHaveLength(0);
    expect(h.runtime.snapshot().journal).toHaveLength(1);

    await h.runtime.replayJournal({ append: true });
    expect(h.main.appends.some((c) => textOf(c).includes('force-stopped'))).toBe(true);
  });

  it('keeps idle roster members behind the deactivation gate', () => {
    const h = harness();
    expect(h.runtime.hasActiveMembers()).toBe(false);
    h.addMember('software-architect', 'agent-0', 'idle');
    expect(h.runtime.hasActiveMembers()).toBe(true);
  });

  it('rejects new messages after disposal', async () => {
    const h = harness();
    h.runtime.dispose();

    await expect(
      h.runtime.send({
        type: 'message',
        from: TEAM_LEAD_ID,
        recipient: 'software-architect',
        summary: 'late',
        text: 'late message',
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'This expert-team runtime is no longer active.',
    });
  });
});
