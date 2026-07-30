/**
 * v2 print host.
 *
 * The runner depends on the SDK's `KimiV2Runtime` and its Klient facade.
 * Scope ownership and engine Service tokens stay behind that host boundary.
 */

import {
  countKimiV2ActiveTasks,
  drainKimiV2BackgroundTasks,
  resolveKimiV2PrintBackgroundSettings,
  type KimiV2Runtime,
} from '@moonshot-ai/kimi-code-sdk/v2';
import { resolve } from 'pathe';

import { PROMPT_CLEANUP_TIMEOUT_MS } from '#/constant/app';

import {
  formatGoalSummaryText,
  goalExitCode,
  goalSummaryJson,
  parseHeadlessGoalCreate,
  type HeadlessGoalCreate,
} from '../goal-prompt';
import { resolveOutputFormat } from '../options';
import type { CLIOptions, PromptOutputFormat } from '../options';
import {
  PromptJsonWriter,
  PromptTranscriptWriter,
  type PromptOutput,
  type PromptTurnWriter,
  writeResumeHint,
} from '../prompt-render';
import {
  type PromptRunIO,
  installPromptTerminationCleanup,
  raceWithTimeout,
  requireConfiguredModel,
} from '../run-prompt';

import { createCliV2Runtime } from './create-v2-runtime';
import {
  applyPrintBackgroundPolicy,
  PrintSteeredTurnFailedError,
  type PrintTurnEnding,
} from './print-background-policy';

export {
  applyPrintBackgroundPolicy,
  createPrintTurnEndings,
  PrintSteeredTurnFailedError,
  type PrintBackgroundPolicyInput,
  type PrintTurnEnding,
  type PrintTurnEndings,
} from './print-background-policy';

const MAIN_AGENT_ID = 'main';

interface TurnEnded {
  readonly type: 'turn.ended';
  readonly turnId: number;
  readonly reason: 'completed' | 'cancelled' | 'failed' | 'blocked';
  readonly error?: unknown;
}

/**
 * Run v2 print mode through the stable host boundary when the requested
 * behavior is representable there.
 */
export async function runV2Print(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  const startedAt = Date.now();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const promptProcess = io.process ?? process;
  const outputFormat = resolveOutputFormat(opts);
  const { runtime, firstLaunch } = await createCliV2Runtime(
    opts,
    version,
    'print',
    'print',
  );
  let removeTerminationCleanup: (() => void) | undefined;
  let restoreSessionPermission = async (): Promise<void> => {};
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    const pending = (cleanupPromise ??= (async () => {
      removeTerminationCleanup?.();
      try {
        await restoreSessionPermission();
      } finally {
        await runtime.close();
      }
    })());
    await raceWithTimeout(pending, PROMPT_CLEANUP_TIMEOUT_MS);
  };
  removeTerminationCleanup = installPromptTerminationCleanup(promptProcess, cleanup);

  try {
    await writeConfigWarnings(runtime, stderr);
    const defaultModel =
      (await runtime.klient.global.config.get<string | undefined>('defaultModel')) ?? undefined;
    const workDir = process.cwd();
    const profileName = await resolveAgentProfileName(runtime, opts, workDir);
    const resolvedSession = await resolveSession(
      runtime,
      opts,
      workDir,
      profileName,
      defaultModel,
      stderr,
    );
    restoreSessionPermission = resolvedSession.restorePermission;
    runtime.telemetry.setContext({
      sessionId: resolvedSession.sessionId,
      model: resolvedSession.model,
    });
    if (firstLaunch) {
      runtime.telemetry.track('first_launch');
    }
    await runtime.klient.global.auth.ensureReady(resolvedSession.model);
    const goal = parseHeadlessGoalCreate(opts.prompt!);
    if (goal === undefined) {
      await runKlientTurn(
        runtime,
        resolvedSession.sessionId,
        opts.prompt!,
        outputFormat,
        stdout,
        stderr,
      );
    } else {
      await runKlientGoal(
        runtime,
        resolvedSession.sessionId,
        goal,
        outputFormat,
        stdout,
        stderr,
      );
    }
    writeResumeHint(resolvedSession.sessionId, outputFormat, stdout, stderr);
    runtime.telemetry.track('exit', { duration_ms: Date.now() - startedAt });
  } finally {
    await cleanup();
  }
}

async function resolveAgentProfileName(
  runtime: KimiV2Runtime,
  opts: CLIOptions,
  workDir: string,
): Promise<string | undefined> {
  if (opts.agent !== undefined) return opts.agent;
  const file = opts.agentFiles[0];
  if (file === undefined) return undefined;
  return runtime.agentFiles.resolveProfileName({ file, workDir });
}

async function writeConfigWarnings(
  runtime: KimiV2Runtime,
  stderr: PromptOutput,
): Promise<void> {
  for (const diagnostic of await runtime.klient.global.config.diagnostics()) {
    if (diagnostic.severity === 'warning') {
      stderr.write(`Warning: ${diagnostic.message}\n`);
    }
  }
}

interface ResolvedSession {
  readonly sessionId: string;
  readonly model: string;
  readonly restorePermission: () => Promise<void>;
}

interface PreviousSession {
  readonly id: string;
}

async function resolveSession(
  runtime: KimiV2Runtime,
  opts: CLIOptions,
  workDir: string,
  profileName: string | undefined,
  defaultModel: string | undefined,
  stderr: PromptOutput,
): Promise<ResolvedSession> {
  const { klient } = runtime;
  let sessionId: string | undefined;
  let createdModel: string | undefined;

  if (opts.session !== undefined) {
    const target = await klient.global.sessions.get(opts.session);
    if (target === undefined) {
      throw new Error(`Session "${opts.session}" not found.`);
    }
    if (target.cwd !== undefined && resolve(target.cwd) !== resolve(workDir)) {
      stderr.write(
        `Session "${opts.session}" was created under a different directory.\n` +
          `  cd "${target.cwd}" && kimi -r ${opts.session}\n\n`,
      );
      throw new Error(`Session "${opts.session}" was created under a different directory.`);
    }
    if (!(await klient.session(target.id).restore())) {
      throw new Error(`Session "${target.id}" not found.`);
    }
    sessionId = target.id;
  } else if (opts.continue) {
    const previous = await findPreviousSession(runtime, workDir);
    if (previous !== undefined && (await klient.session(previous.id).restore())) {
      sessionId = previous.id;
    } else {
      stderr.write(`No sessions to continue under "${workDir}"; starting a fresh session.\n`);
    }
  }

  if (sessionId === undefined) {
    createdModel = requireConfiguredModel(opts.model, defaultModel);
    const created = await klient.global.sessions.create({
      workDir,
      additionalDirs: opts.addDirs?.length ? opts.addDirs : undefined,
      mainAgentBinding: {
        profile: profileName ?? 'agent',
        model: createdModel,
      },
    });
    sessionId = created.id;
  }

  const agent = klient.session(sessionId).agent(MAIN_AGENT_ID);
  if (createdModel !== undefined) {
    await agent.setPermission('auto');
    return {
      sessionId,
      model: createdModel,
      restorePermission: async () => {},
    };
  }

  const profile = await agent.profile.get();
  let currentModel = profile.modelAlias ?? '';
  if (profileName !== undefined && profile.profileName !== profileName) {
    const model = requireConfiguredModel(opts.model, currentModel, defaultModel);
    await agent.profile.bind({ profile: profileName, model });
    currentModel = model;
  } else if (opts.model !== undefined || currentModel.length === 0) {
    const model = requireConfiguredModel(opts.model, currentModel, defaultModel);
    if (currentModel !== model) {
      currentModel = (await agent.setModel(model)).model;
    }
  }
  const model = requireConfiguredModel(currentModel, defaultModel);
  const previousPermission = await agent.getPermission();
  if (previousPermission !== 'auto') {
    await agent.setPermission('auto');
  }
  return {
    sessionId,
    model,
    restorePermission: async () => {
      if (previousPermission !== 'auto') {
        await agent.setPermission(previousPermission);
      }
    },
  };
}

async function findPreviousSession(
  runtime: KimiV2Runtime,
  workDir: string,
): Promise<PreviousSession | undefined> {
  const normalizedWorkDir = resolve(workDir);
  const visitedCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await runtime.klient.global.sessions.list({
      cursor,
      limit: 100,
    });
    const previous = page.items.find(
      (summary) => summary.cwd !== undefined && resolve(summary.cwd) === normalizedWorkDir,
    );
    if (previous !== undefined) return previous;
    cursor = page.nextCursor;
    if (cursor === undefined || visitedCursors.has(cursor)) return undefined;
    visitedCursors.add(cursor);
  }
}

async function runKlientGoal(
  runtime: KimiV2Runtime,
  sessionId: string,
  goal: HeadlessGoalCreate,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  const goalFacade = runtime.klient.session(sessionId).agent(MAIN_AGENT_ID).goal;
  await goalFacade.create({
    objective: goal.objective,
    replace: goal.replace,
  });
  try {
    await runKlientTurn(
      runtime,
      sessionId,
      goal.objective,
      outputFormat,
      stdout,
      stderr,
    );
  } finally {
    const snapshot = await goalFacade.get();
    if (outputFormat === 'stream-json') {
      stdout.write(`${JSON.stringify(goalSummaryJson(snapshot))}\n`);
    } else {
      stderr.write(`${formatGoalSummaryText(snapshot)}\n`);
    }
    if (snapshot !== null && snapshot.status !== 'complete') {
      process.exitCode = goalExitCode(snapshot.status);
    }
  }
}

async function runKlientTurn(
  runtime: KimiV2Runtime,
  sessionId: string,
  prompt: string,
  outputFormat: PromptOutputFormat,
  stdout: PromptOutput,
  stderr: PromptOutput,
): Promise<void> {
  const session = runtime.klient.session(sessionId);
  const agent = session.agent(MAIN_AGENT_ID);
  const writer: PromptTurnWriter =
    outputFormat === 'stream-json'
      ? new PromptJsonWriter(stdout)
      : new PromptTranscriptWriter(stdout, stderr);
  const endings = createTurnEndingQueue();
  const subscriptions = [
    agent.events.on('turn.step.started', () => {
      writer.flushAssistant();
    }),
    agent.events.on('turn.step.interrupted', () => {
      writer.flushAssistant();
    }),
    agent.events.on('turn.step.retrying', (event) => {
      writer.discardAssistant();
      writer.writeRetrying(event);
    }),
    agent.events.on('assistant.delta', (event) => {
      writer.writeAssistantDelta(event.delta);
    }),
    agent.events.on('hook.result', (event) => {
      writer.writeHookResult(event);
    }),
    agent.events.on('thinking.delta', (event) => {
      writer.writeThinkingDelta(event.delta);
    }),
    agent.events.on('tool.call.delta', (event) => {
      writer.writeToolCallDelta(event.toolCallId, event.name, event.argumentsPart);
    }),
    agent.events.on('tool.call.started', (event) => {
      writer.writeToolCall(event.toolCallId, event.name, event.args);
    }),
    agent.events.on('tool.progress', (event) => {
      if (event.update.text !== undefined && event.update.text.length > 0) {
        stderr.write(
          event.update.text.endsWith('\n') ? event.update.text : `${event.update.text}\n`,
        );
      }
    }),
    agent.events.on('tool.result', (event) => {
      writer.writeToolResult(event.toolCallId, event.output);
    }),
    agent.events.on('warning', (event) => stderr.write(`Warning: ${event.message}\n`)),
    agent.events.on('turn.ended', (event) => {
      writer.flushAssistant();
      endings.push(event);
    }),
  ];
  try {
    // Memory-channel listeners and calls share the same ordered Scope
    // resolver. Register listeners first, then use a completed agent call as
    // the attachment barrier before dispatching the prompt.
    await agent.getModel();
    const launched = await agent.prompt({
      input: [{ type: 'text', text: prompt }],
    });
    if (launched === undefined) {
      writer.finish();
      throw new Error('Prompt hook blocked the request.');
    }
    const mainEnding = await endings.take(launched.turn_id);
    if (mainEnding.reason !== 'completed') {
      writer.finish();
      throw new Error(formatTurnFailure(mainEnding));
    }
    await finishBackgroundWork(runtime, sessionId, mainEnding.turnId, endings, stderr);
    writer.finish();
  } catch (error) {
    writer.finish();
    throw error;
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
  }
}

async function finishBackgroundWork(
  runtime: KimiV2Runtime,
  sessionId: string,
  mainTurnId: number,
  endings: TurnEndingQueue,
  stderr: PromptOutput,
): Promise<void> {
  const settings = await resolveKimiV2PrintBackgroundSettings(runtime);
  const session = runtime.klient.session(sessionId);
  const agent = session.agent(MAIN_AGENT_ID);
  try {
    await applyPrintBackgroundPolicy({
      mode: settings.mode,
      ceilingS: settings.ceilingS,
      maxTurns: settings.maxTurns,
      countPending: () => countKimiV2ActiveTasks(runtime, sessionId),
      drain: () =>
        drainKimiV2BackgroundTasks(runtime, sessionId, settings.ceilingS),
      turnEndings: {
        next: async (remainingMs, skipTurnId) => {
          const ending = await endings.takeNext(skipTurnId, remainingMs);
          return ending as PrintTurnEnding | null;
        },
      },
      skipTurnId: mainTurnId,
      warn: (message) => stderr.write(`Warning: ${message}\n`),
      now: () => Date.now(),
      goalActive: async () => (await agent.goal.get())?.status === 'active',
      cronNextFireAt: () => session.cron.getNextFireTime(),
    });
  } catch (error) {
    if (error instanceof PrintSteeredTurnFailedError) {
      throw error;
    }
    stderr.write(
      `Warning: print background policy failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

interface TurnEndingQueue {
  push(ending: TurnEnded): void;
  take(turnId: number): Promise<TurnEnded>;
  takeNext(skipTurnId: number, timeoutMs: number): Promise<TurnEnded | null>;
}

function createTurnEndingQueue(): TurnEndingQueue {
  const buffer: TurnEnded[] = [];
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of waiters) waiter();
  };
  const wait = (timeoutMs?: number): Promise<void> =>
    new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (!waiters.delete(done)) return;
        if (timer !== undefined) clearTimeout(timer);
        // oxlint-disable-next-line promise/no-multiple-resolved -- deletion from waiters is the single-settlement guard
        resolve();
      };
      waiters.add(done);
      if (timeoutMs !== undefined) timer = setTimeout(done, Math.max(0, timeoutMs));
    });
  return {
    push(ending) {
      buffer.push(ending);
      wake();
    },
    async take(turnId) {
      for (;;) {
        const index = buffer.findIndex((ending) => ending.turnId === turnId);
        if (index >= 0) return buffer.splice(index, 1)[0]!;
        await wait();
      }
    },
    async takeNext(skipTurnId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = buffer.findIndex((ending) => ending.turnId !== skipTurnId);
        if (index >= 0) return buffer.splice(index, 1)[0]!;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await wait(remaining);
      }
    },
  };
}

function formatTurnFailure(ending: TurnEnded): string {
  const payload =
    typeof ending.error === 'object' && ending.error !== null
      ? (ending.error as { readonly code?: string; readonly message?: string })
      : undefined;
  if (payload?.code === 'provider.filtered') {
    return 'Provider safety policy blocked the response.';
  }
  if (payload?.code !== undefined) {
    return `${payload.code}: ${payload.message ?? ''}`.trimEnd();
  }
  if (ending.reason === 'blocked') return 'Prompt hook blocked the request.';
  return `Prompt turn ended with reason: ${ending.reason}`;
}
