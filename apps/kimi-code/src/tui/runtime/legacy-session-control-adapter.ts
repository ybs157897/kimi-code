import type { KimiHarness, Session, SessionSummary } from '@moonshot-ai/kimi-code-sdk';

import {
  MAIN_AGENT_ID,
  type SessionAgentControlPort,
  type SessionControlPort,
  type SessionIdentity,
  type SessionLifecyclePort,
} from './session-control-port';

interface LegacySessionControlHarness {
  listSessions(
    input?: Parameters<KimiHarness['listSessions']>[0],
  ): ReturnType<KimiHarness['listSessions']>;
  createSession(
    input: Parameters<KimiHarness['createSession']>[0],
  ): ReturnType<KimiHarness['createSession']>;
  resumeSession(
    input: Parameters<KimiHarness['resumeSession']>[0],
  ): ReturnType<KimiHarness['resumeSession']>;
  renameSession(
    input: Parameters<KimiHarness['renameSession']>[0],
  ): ReturnType<KimiHarness['renameSession']>;
  forkSession(
    input: Parameters<KimiHarness['forkSession']>[0],
  ): ReturnType<KimiHarness['forkSession']>;
  getSession(id: string): Session | undefined;
  withInteractiveAgent<T>(agentId: string, operation: () => T): T;
}

/** Bridge the current SDK harness into the runtime-neutral TUI control port. */
export function createLegacySessionControlPort(
  harness: LegacySessionControlHarness,
): SessionControlPort {
  return {
    sessions: {
      list: async (input = {}) => {
        const sessions = await harness.listSessions({
          workDir: input.workDir,
          sessionId: input.sessionId,
        });
        return sessions
          .filter((session) => input.includeArchived === true || session.archived !== true)
          .map(legacyIdentity);
      },
      create: async (input) => {
        const session = await harness.createSession({
          workDir: input.workDir,
          model: input.model,
          thinking: input.thinking,
          permission: input.permission,
          planMode: input.planMode,
          additionalDirs: input.additionalDirs,
        });
        return activeLegacyIdentity(session);
      },
      resume: async (input) => {
        const session = await harness.resumeSession({
          id: input.id,
          additionalDirs: input.additionalDirs,
          replayTurnLimit: input.replayTurnLimit,
        });
        return activeLegacyIdentity(session);
      },
    },
    session: (sessionId) => createLegacySessionLifecycle(harness, sessionId),
    agent: (sessionId, agentId = MAIN_AGENT_ID) =>
      createLegacyAgentControl(harness, sessionId, agentId),
  };
}

function createLegacySessionLifecycle(
  harness: LegacySessionControlHarness,
  sessionId: string,
): SessionLifecyclePort {
  return {
    getIdentity: async () => activeLegacyIdentity(requireLegacySession(harness, sessionId)),
    close: async () => {
      await requireLegacySession(harness, sessionId).close();
    },
    setTitle: async (title) => {
      await harness.renameSession({ id: sessionId, title });
    },
    fork: async (input = {}) => {
      const session = await harness.forkSession({
        id: sessionId,
        title: input.title,
      });
      return activeLegacyIdentity(session);
    },
  };
}

function createLegacyAgentControl(
  harness: LegacySessionControlHarness,
  sessionId: string,
  agentId: string,
): SessionAgentControlPort {
  const run = <T>(operation: (session: Session) => T): T => {
    const session = requireLegacySession(harness, sessionId);
    return harness.withInteractiveAgent(agentId, () => operation(session));
  };

  return {
    prompt: async (input) => {
      await run((session) => session.prompt(input));
    },
    steer: async (input) => {
      await run((session) => session.steer(input));
    },
    cancel: async () => {
      await run((session) => session.cancel());
    },
    runShellCommand: (command, commandId) =>
      run((session) => session.runShellCommand(command, { commandId })),
    cancelShellCommand: async (commandId) => {
      await run((session) => session.cancelShellCommand(commandId));
    },
    getStatus: () => run((session) => session.getStatus()),
    getModel: async () => (await run((session) => session.getStatus())).model,
    setModel: async (model) => {
      await run((session) => session.setModel(model));
    },
    getThinking: async () =>
      (await run((session) => session.getStatus())).thinkingEffort,
    setThinking: async (effort) => {
      await run((session) => session.setThinking(effort));
    },
    setPermission: async (mode) => {
      await run((session) => session.setPermission(mode));
    },
    getPlan: () => run((session) => session.getPlan()),
    setPlanMode: async (enabled) => {
      await run((session) => session.setPlanMode(enabled));
    },
    clearPlan: async () => {
      await run((session) => session.clearPlan());
    },
    getGoal: async () => (await run((session) => session.getGoal())).goal,
    createGoal: (input) => run((session) => session.createGoal(input)),
    pauseGoal: () => run((session) => session.pauseGoal()),
    resumeGoal: () => run((session) => session.resumeGoal()),
    cancelGoal: () => run((session) => session.cancelGoal()),
    listTasks: (input = {}) =>
      run((session) =>
        session.listBackgroundTasks({
          activeOnly: input.activeOnly,
          limit: input.limit,
        }),
      ),
    detachTask: (taskId) =>
      run((session) => session.detachBackgroundTask(taskId)),
    getTaskOutput: (taskId, tail) =>
      run((session) => session.getBackgroundTaskOutput(taskId, { tail })),
    stopTask: async (taskId, reason) => {
      await run((session) => session.stopBackgroundTask(taskId, { reason }));
    },
  };
}

function requireLegacySession(
  harness: LegacySessionControlHarness,
  sessionId: string,
): Session {
  const session = harness.getSession(sessionId);
  if (session === undefined) {
    throw new Error(`Session "${sessionId}" is not active.`);
  }
  return session;
}

function activeLegacyIdentity(session: Session): SessionIdentity {
  const summary = session.summary;
  if (summary === undefined) {
    throw new Error(`Session "${session.id}" has no identity summary.`);
  }
  return {
    ...legacyIdentity(summary),
    id: session.id,
  };
}

function legacyIdentity(summary: SessionSummary): SessionIdentity {
  return {
    id: summary.id,
    workDir: summary.workDir,
    title: summary.title,
    lastPrompt: summary.lastPrompt,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: summary.archived ?? false,
    metadata: summary.metadata === undefined ? undefined : { ...summary.metadata },
  };
}
