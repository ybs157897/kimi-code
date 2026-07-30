/**
 * Scenario: prompt-driven session behavior, including historical-turn forks.
 * Responsibilities: public SDK events, persisted replay, metadata, and input errors.
 * Wiring: real in-process core/storage with only the remote model provider stubbed.
 * Run: pnpm exec vitest run packages/node-sdk/test/session-prompt-events.test.ts
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createKimiHarness,
  type ApprovalRequest,
  type Event,
  type KimiHarness,
  type QuestionRequest,
} from '#/index';

import { TEST_IDENTITY } from './test-identity';
import { startFakeProvider, type FakeProvider } from './v2-runtime-fixture';

const fakeProviderState = {
  responseText: 'hello from fake provider',
};

const tempDirs: string[] = [];
let fakeProvider: FakeProvider | undefined;

beforeEach(async () => {
  fakeProviderState.responseText = 'hello from fake provider';
  fakeProvider = await startFakeProvider({
    fallbackResponse: () => ({ kind: 'text', text: fakeProviderState.responseText }),
  });
});

afterEach(async () => {
  await fakeProvider?.close();
  fakeProvider = undefined;
  for (const dir of tempDirs.splice(0)) {
    await removeTempDir(dir);
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-prompt-'));
  tempDirs.push(dir);
  return dir;
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') {
        throw error;
      }
      await delay(10);
    }
  }

  await rm(dir, { recursive: true, force: true });
}

describe('Session.prompt events', () => {
  it('preserves existing custom metadata when an SDK metadata patch is resumed', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({
        id: 'ses_update_metadata',
        workDir,
        metadata: { source: 'vscode' },
      });
      await session.createGoal({ objective: 'Keep core-owned metadata' });
      await session.updateMetadata({
        vscode_legacy_approval: { yolo: true, afk: false },
      });
      await session.close();

      const resumed = await harness.resumeSession({ id: session.id });

      expect(resumed.summary?.metadata).toEqual({
        source: 'vscode',
        vscode_legacy_approval: { yolo: true, afk: false },
      });
      await expect(resumed.getGoal()).resolves.toMatchObject({
        goal: { objective: 'Keep core-owned metadata' },
      });
    } finally {
      await harness.close();
    }
  });

  it('persists sanitized prompt metadata without marking the title custom', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_prompt_meta', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      let done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('use api_key=secret-value for the request');
      await done;

      const statePath = join(session.summary!.sessionDir, 'state.json');
      const firstState = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(firstState['title']).toBe('use api_key=[redacted] for the request');
      expect(firstState['isCustomTitle']).toBe(false);
      expect(firstState['lastPrompt']).toBe('use api_key=[redacted] for the request');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          title: 'use api_key=[redacted] for the request',
          patch: expect.objectContaining({
            isCustomTitle: false,
            lastPrompt: 'use api_key=[redacted] for the request',
          }),
        }),
      );

      events.length = 0;
      done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('second prompt');
      await done;

      const secondState = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(secondState['title']).toBe('use api_key=[redacted] for the request');
      expect(secondState['isCustomTitle']).toBe(false);
      expect(secondState['lastPrompt']).toBe('second prompt');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          patch: expect.objectContaining({
            lastPrompt: 'second prompt',
          }),
        }),
      );

      events.length = 0;
      done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt([{ type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } }]);
      await done;
      unsubscribe();

      const mediaState = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(mediaState['title']).toBe('use api_key=[redacted] for the request');
      expect(mediaState['lastPrompt']).toBe('[image]');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          patch: expect.objectContaining({
            lastPrompt: '[image]',
          }),
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it('emits mapped turn events through Session.onEvent', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_prompt_events', workDir });
      const events: Event[] = [];
      const done = waitForEvent(session, (event) => event.type === 'turn.ended');
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await session.prompt('hello');
      await done;
      unsubscribe();

      expect(events.some((event) => event.type === 'turn.started')).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'assistant.delta',
          sessionId: session.id,
          turnId: 0,
          delta: 'hello from fake provider',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.ended',
          sessionId: session.id,
          turnId: 0,
          reason: 'completed',
        }),
      );
      expect(providerMessages(0)).toContain('You are Kimi Code CLI');
      expect(providerMessages(0)).toContain('Available skills');
      expect(requireFakeProvider().requests[0]?.body).toMatchObject({
        model: 'stub-model',
        stream: true,
      });
      expect(existsSync(join(homeDir, 'device_id'))).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('routes a v2 tool approval through the public Session handler', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({
        id: 'ses_prompt_approval',
        workDir,
        permission: 'manual',
      });
      let received: ApprovalRequest | undefined;
      session.setApprovalHandler((request) => {
        received = request;
        return { decision: 'approved', selectedLabel: 'Approve once' };
      });
      requireFakeProvider().push(
        {
          kind: 'tool_call',
          id: 'call_sdk_approval',
          name: 'Bash',
          arguments: JSON.stringify({ command: 'printf sdk-approved' }),
        },
        { kind: 'text', text: 'approval complete' },
      );
      const done = waitForEvent(session, (event) => event.type === 'turn.ended');

      await session.prompt('run the harmless command');
      await expect(done).resolves.toMatchObject({
        type: 'turn.ended',
        reason: 'completed',
      });

      expect(received).toMatchObject({
        sessionId: session.id,
        agentId: 'main',
        turnId: 0,
        toolCallId: 'call_sdk_approval',
        toolName: 'Bash',
        display: expect.objectContaining({
          kind: 'command',
          command: 'printf sdk-approved',
        }),
      });
      expect(providerMessages(1)).toContain('sdk-approved');
    } finally {
      await harness.close();
    }
  });

  it('routes a v2 structured question through the public Session handler', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({
        id: 'ses_prompt_question',
        workDir,
        permission: 'manual',
      });
      let received: QuestionRequest | undefined;
      session.setQuestionHandler((request) => {
        received = request;
        return { 'Choose a mode?': 'Fast' };
      });
      requireFakeProvider().push(
        {
          kind: 'tool_call',
          id: 'call_sdk_question',
          name: 'AskUserQuestion',
          arguments: JSON.stringify({
            questions: [
              {
                question: 'Choose a mode?',
                header: 'Mode',
                options: [
                  { label: 'Fast', description: 'Finish quickly.' },
                  { label: 'Safe', description: 'Add more checks.' },
                ],
                multi_select: false,
              },
            ],
          }),
        },
        { kind: 'text', text: 'question complete' },
      );
      const done = waitForEvent(session, (event) => event.type === 'turn.ended');

      await session.prompt('ask me to choose');
      await expect(done).resolves.toMatchObject({
        type: 'turn.ended',
        reason: 'completed',
      });

      expect(received).toMatchObject({
        sessionId: session.id,
        agentId: 'main',
        turnId: 0,
        toolCallId: 'call_sdk_question',
        questions: [
          expect.objectContaining({
            question: 'Choose a mode?',
            options: [
              expect.objectContaining({ label: 'Fast' }),
              expect.objectContaining({ label: 'Safe' }),
            ],
          }),
        ],
      });
      expect(providerMessages(1)).toContain('Fast');
    } finally {
      await harness.close();
    }
  });

  it('keeps replay and one event subscription after a public Session reload', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_prompt_reload', workDir });
      await runPrompt(session, 'before reload', 'persisted answer');
      const reloaded = await session.reloadSession();
      expect(visibleReplayText(reloaded.agents['main']?.replay ?? [])).toEqual([
        'user:before reload',
        'assistant:persisted answer',
      ]);

      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => events.push(event));
      await runPrompt(session, 'after reload', 'fresh answer');
      await delay(25);
      unsubscribe();

      expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'assistant.delta')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'turn.ended')).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.started',
          sessionId: session.id,
          turnId: 1,
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it('does not respond or emit late events after close with a pending approval handler', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({
        id: 'ses_prompt_close_pending',
        workDir,
        permission: 'manual',
      });
      let resolveApproval!: () => void;
      const approvalResolved = new Promise<void>((resolve) => {
        resolveApproval = resolve;
      });
      let approvalSeen!: () => void;
      const handlerStarted = new Promise<void>((resolve) => {
        approvalSeen = resolve;
      });
      session.setApprovalHandler(async () => {
        approvalSeen();
        await approvalResolved;
        return { decision: 'approved' };
      });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => events.push(event));
      requireFakeProvider().push({
        kind: 'tool_call',
        id: 'call_sdk_close',
        name: 'Bash',
        arguments: JSON.stringify({ command: 'printf should-not-run' }),
      });

      await session.prompt('wait for approval');
      await handlerStarted;
      await session.close();
      const countAfterClose = events.length;
      resolveApproval();
      await delay(25);
      unsubscribe();

      expect(events).toHaveLength(countAfterClose);
      expect(requireFakeProvider().requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('supports onEvent unsubscribe without touching runtime wire directly', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_prompt_unsubscribe', workDir });
      const unsubscribedEvents: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        unsubscribedEvents.push(event);
      });
      unsubscribe();
      const done = waitForEvent(session, (event) => event.type === 'turn.ended');

      await session.prompt([{ type: 'text', text: 'hello' }]);
      await done;

      expect(unsubscribedEvents).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('runs init through generateAgentsMd RPC as a subagent system trigger without prompt metadata updates', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_init_rpc', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await session.init();
      unsubscribe();

      const spawned = events.find((event) => event.type === 'subagent.spawned');
      expect(spawned).toMatchObject({
        type: 'subagent.spawned',
        sessionId: session.id,
        agentId: 'main',
        subagentName: 'coder',
        parentToolCallId: 'generate-agents-md',
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.started',
          sessionId: session.id,
          agentId: spawned?.type === 'subagent.spawned' ? spawned.subagentId : undefined,
          origin: { kind: 'system_trigger', name: 'subagent' },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          patch: { agents: expect.any(Object) },
        }),
      );
      expect(
        events.filter(
          (event) =>
            event.type === 'session.meta.updated' &&
            event.patch !== undefined &&
            (Object.hasOwn(event.patch, 'lastPrompt') ||
              Object.hasOwn(event.patch, 'title') ||
              Object.hasOwn(event.patch, 'isCustomTitle')),
        ),
      ).toEqual(
        [],
      );
      expect(providerMessages(0)).toContain('Task requirements:');

      const statePath = join(session.summary!.sessionDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(state['lastPrompt']).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('includes persisted subagent replay only when resume explicitly requests it', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_subagent_replay', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => events.push(event));
      await session.init();
      unsubscribe();
      const spawned = events.find((event) => event.type === 'subagent.spawned');
      if (spawned?.type !== 'subagent.spawned') throw new Error('Expected persisted subagent');
      await session.close();

      const defaultResume = await harness.resumeSession({ id: session.id });
      expect(defaultResume.getResumeState()?.agents).not.toHaveProperty(spawned.subagentId);
      await defaultResume.close();

      const fullResume = await harness.resumeSession({
        id: session.id,
        includeSubagents: true,
      });
      expect(fullResume.getResumeState()?.agents[spawned.subagentId]?.replay).toContainEqual(
        expect.objectContaining({
          type: 'message',
          message: expect.objectContaining({ role: 'assistant' }),
        }),
      );
    } finally {
      await harness.close();
    }
  });

  it('starts btw through RPC as a registered forked agent with v2 prompt metadata', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await configureFakeProvider(harness);
      const session = await harness.createSession({ id: 'ses_btw_rpc', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      let done = waitForEvent(session, (event) => event.type === 'turn.ended');
      await session.prompt('main task context');
      await done;

      fakeProviderState.responseText = 'The main agent is working from the existing context.';
      events.length = 0;
      done = waitForEvent(
        session,
        (event) => event.type === 'turn.ended' && event.agentId !== 'main',
      );

      const agentId = await session.startBtw();
      await harness.withInteractiveAgent(agentId, () =>
        session.prompt('What are you working on right now?'),
      );
      await done;
      unsubscribe();
      expect(harness.interactiveAgentId).toBe('main');

      const started = events.find(
        (event) =>
          event.type === 'turn.started' &&
          event.agentId === agentId &&
          event.origin.kind === 'user',
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'turn.started',
          sessionId: session.id,
          agentId,
          origin: { kind: 'user' },
        }),
      );
      expect(started?.agentId).not.toBe('main');
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.spawned' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.completed' }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: 'subagent.failed' }));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          patch: { agents: expect.any(Object) },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.meta.updated',
          patch: { lastPrompt: 'What are you working on right now?' },
        }),
      );
      expect(providerSystemMessage(1)).toStrictEqual(providerSystemMessage(0));
      const btwHistoryText = providerMessages(1);
      expect(btwHistoryText).toContain('main task context');
      expect(btwHistoryText).toContain('What are you working on right now?');

      const statePath = join(session.summary!.sessionDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(state['lastPrompt']).toBe('What are you working on right now?');
      expect(state['agents']).toMatchObject({
        main: expect.any(Object),
        [agentId]: expect.any(Object),
      });

      await harness.closeSession(session.id);
      const resumed = await harness.resumeSession({ id: session.id });
      const resumeState = resumed.getResumeState();
      expect(resumeState?.agents).toMatchObject({ main: expect.any(Object) });
      expect(resumeState?.agents).not.toHaveProperty(agentId);
      expect(resumeState?.sessionMetadata.agents).toHaveProperty(agentId);
    } finally {
      await harness.close();
    }
  });

  it('persists only conversation through the selected turn across resume', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_source', workDir });
      await runPrompt(source, 'first question', 'first answer');
      await runPrompt(source, 'second question', 'second answer');
      await runPrompt(source, 'third question', 'third answer');

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_turn_fork_child',
        turnIndex: 1,
      });
      await fork.close();
      const resumed = await harness.resumeSession({ id: fork.id });
      const replayText = visibleReplayText(resumed.getResumeState()?.agents['main']?.replay ?? []);

      expect(replayText).toEqual([
        'user:first question',
        'assistant:first answer',
        'user:second question',
        'assistant:second answer',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('returns the requested identity for a historical fork', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({
        id: 'ses_turn_fork_metadata_source',
        workDir,
        metadata: { source: 'vscode' },
      });
      await runPrompt(source, 'branch here', 'kept answer');
      await runPrompt(source, 'future prompt', 'discarded answer');

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_turn_fork_metadata_child',
        title: 'Historical branch',
        metadata: { branch: 'historical' },
        turnIndex: 0,
      });
      const state = fork.getResumeState();

      expect(fork.id).toBe('ses_turn_fork_metadata_child');
      expect(fork.workDir).toBe(source.workDir);
      expect(state?.sessionMetadata.forkedFrom).toBe(source.id);
    } finally {
      await harness.close();
    }
  });

  it('derives historical fork metadata from the selected turn', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({
        id: 'ses_turn_fork_state_source',
        workDir,
        metadata: { source: 'vscode' },
      });
      await runPrompt(source, 'branch here', 'kept answer');
      await runPrompt(source, 'future prompt', 'discarded answer');

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_turn_fork_state_child',
        title: 'Historical branch',
        metadata: { branch: 'historical' },
        turnIndex: 0,
      });

      expect(fork.summary).toMatchObject({
        title: 'Historical branch',
        lastPrompt: 'branch here',
        metadata: { source: 'vscode', branch: 'historical' },
      });
      expect(fork.getResumeState()?.sessionMetadata).toMatchObject({
        title: 'Historical branch',
        lastPrompt: 'branch here',
        custom: { source: 'vscode', branch: 'historical' },
      });
    } finally {
      await harness.close();
    }
  });

  it('continues with the next turn id after a historical fork', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_id_source', workDir });
      await runPrompt(source, 'kept prompt', 'kept answer');
      await runPrompt(source, 'future prompt', 'future answer');
      const fork = await harness.forkSession({ id: source.id, turnIndex: 0 });
      const started = waitForEvent(fork, (event) => event.type === 'turn.started');
      const ended = waitForEvent(fork, (event) => event.type === 'turn.ended');

      await fork.prompt('branch continuation');

      await expect(started).resolves.toMatchObject({ type: 'turn.started', turnId: 1 });
      await ended;
    } finally {
      await harness.close();
    }
  });

  it('omits subagents created after the selected historical turn', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_agents_source', workDir });
      await runPrompt(source, 'kept prompt', 'kept answer');
      await runPrompt(source, 'future prompt', 'future answer');
      await source.init();

      const fork = await harness.forkSession({ id: source.id, turnIndex: 0 });

      expect(Object.keys(fork.getResumeState()?.sessionMetadata.agents ?? {})).toEqual(['main']);
    } finally {
      await harness.close();
    }
  });

  it('allows a full fork while the source has an active turn', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    let releaseApproval = (): void => {};

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({
        id: 'ses_active_full_fork_source',
        workDir,
        permission: 'manual',
      });
      const approvalReleased = new Promise<void>((resolve) => {
        releaseApproval = resolve;
      });
      let markApprovalStarted!: () => void;
      const approvalStarted = new Promise<void>((resolve) => {
        markApprovalStarted = resolve;
      });
      source.setApprovalHandler(async () => {
        markApprovalStarted();
        await approvalReleased;
        return { decision: 'approved' };
      });
      requireFakeProvider().push(
        {
          kind: 'tool_call',
          id: 'call_active_full_fork',
          name: 'Bash',
          arguments: JSON.stringify({ command: 'printf full-fork' }),
        },
        { kind: 'text', text: 'source turn completed' },
      );
      const sourceEnded = waitForEvent(source, (event) => event.type === 'turn.ended');

      await source.prompt('hold this turn while forking');
      await approvalStarted;
      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_active_full_fork_child',
      });

      expect(fork.id).toBe('ses_active_full_fork_child');
      expect(fork.getResumeState()?.sessionMetadata.forkedFrom).toBe(source.id);
      releaseApproval();
      releaseApproval = (): void => {};
      await sourceEnded;
      await delay(25);
    } finally {
      releaseApproval();
      await harness.close();
    }
  });

  it('rejects an indexed fork while the source has an active turn', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    let releaseApproval = (): void => {};

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({
        id: 'ses_active_indexed_fork_source',
        workDir,
        permission: 'manual',
      });
      await runPrompt(source, 'persisted turn', 'persisted answer');
      const approvalReleased = new Promise<void>((resolve) => {
        releaseApproval = resolve;
      });
      let markApprovalStarted!: () => void;
      const approvalStarted = new Promise<void>((resolve) => {
        markApprovalStarted = resolve;
      });
      source.setApprovalHandler(async () => {
        markApprovalStarted();
        await approvalReleased;
        return { decision: 'approved' };
      });
      requireFakeProvider().push(
        {
          kind: 'tool_call',
          id: 'call_active_indexed_fork',
          name: 'Bash',
          arguments: JSON.stringify({ command: 'printf indexed-fork' }),
        },
        { kind: 'text', text: 'active turn completed' },
      );
      const sourceEnded = waitForEvent(source, (event) => event.type === 'turn.ended');

      await source.prompt('hold indexed fork source');
      await approvalStarted;
      await expect(
        harness.forkSession({
          id: source.id,
          forkId: 'ses_active_indexed_fork_child',
          turnIndex: 0,
        }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.fork_active_turn',
        details: {
          sessionId: source.id,
          agentId: 'main',
          userVisibleTurnIndex: 0,
        },
      });
      await expect(
        harness.listSessions({ sessionId: 'ses_active_indexed_fork_child' }),
      ).resolves.toEqual([]);
      releaseApproval();
      releaseApproval = (): void => {};
      await sourceEnded;
      await delay(25);
    } finally {
      releaseApproval();
      await harness.close();
    }
  });

  it('rejects a negative historical turn index with request.invalid', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      const source = await harness.createSession({ id: 'ses_turn_fork_negative', workDir });

      await expect(
        harness.forkSession({ id: source.id, turnIndex: -1 }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.invalid',
      });
    } finally {
      await harness.close();
    }
  });

  it('rejects an out-of-range historical turn without creating the fork', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });

    try {
      await configureFakeProvider(harness);
      const source = await harness.createSession({ id: 'ses_turn_fork_range_source', workDir });
      await runPrompt(source, 'only question', 'only answer');

      await expect(
        harness.forkSession({
          id: source.id,
          forkId: 'ses_turn_fork_range_child',
          turnIndex: 1,
        }),
      ).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.invalid',
        details: { turnIndex: 1, availableTurns: 1 },
      });
      await expect(
        harness.listSessions({ sessionId: 'ses_turn_fork_range_child' }),
      ).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('rejects empty prompt input', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_empty_prompt', workDir });
      await expect(session.prompt('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.prompt_input_empty',
      });
    } finally {
      await harness.close();
    }
  });
});

async function runPrompt(
  session: Parameters<typeof waitForEvent>[0] & { prompt(input: string): Promise<void> },
  input: string,
  response: string,
): Promise<void> {
  fakeProviderState.responseText = response;
  const done = waitForEvent(session, (event) => event.type === 'turn.ended');
  await session.prompt(input);
  await done;
}

function visibleReplayText(
  records: readonly {
    readonly type: string;
    readonly message?: {
      readonly role: string;
      readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      readonly origin?: { readonly kind: string };
    };
  }[],
): readonly string[] {
  const entries: string[] = [];
  for (const record of records) {
    if (record.type !== 'message' || record.message === undefined) continue;
    const { message } = record;
    if (message.role === 'user' && message.origin?.kind !== 'user') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
    entries.push(`${message.role}:${text}`);
  }
  return entries;
}

async function configureFakeProvider(harness: KimiHarness): Promise<void> {
  await harness.setConfig({
    models: {
      'fake-model': {
        name: 'stub-model',
        protocol: 'openai',
        baseUrl: requireFakeProvider().baseUrl,
        apiKey: 'YOUR_API_KEY',
        maxContextSize: 262144,
        capabilities: ['tool_use'],
      },
    },
    defaultModel: 'fake-model',
  });
}

function requireFakeProvider(): FakeProvider {
  if (fakeProvider === undefined) throw new Error('Fake provider was not initialized');
  return fakeProvider;
}

function providerMessages(index: number): string {
  return JSON.stringify(requireFakeProvider().requests[index]?.body.messages ?? []);
}

function providerSystemMessage(index: number): unknown {
  const messages = requireFakeProvider().requests[index]?.body.messages;
  return messages?.find(
    (message): message is { readonly role: string } =>
      typeof message === 'object' &&
      message !== null &&
      'role' in message &&
      message.role === 'system',
  );
}

function waitForEvent(
  session: {
    onEvent(listener: (event: Event) => void): () => void;
  },
  predicate: (event: Event) => boolean,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for session event'));
    }, 5_000);
    const unsubscribe = session.onEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}
