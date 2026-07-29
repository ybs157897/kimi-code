import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import {
  MAIN_AGENT_ID,
  type AgentGoal,
  type AgentPlan,
  type AgentPromptInput,
  type AgentPromptPart,
  type AgentTask,
  type SessionAgentControlPort,
  type SessionControlPort,
  type SessionIdentity,
  type SessionLifecyclePort,
  type SessionListInput,
} from './session-control-port';

type Klient = KimiV2Runtime['klient'];
type KlientSession = ReturnType<Klient['session']>;
type KlientAgent = ReturnType<KlientSession['agent']>;
type KlientSessionSummary = Awaited<
  ReturnType<Klient['global']['sessions']['list']>
>['items'][number];
type KlientSessionMeta = Awaited<ReturnType<KlientSession['get']>>;

/** Bridge a v2 runtime (or its Klient facade) into the neutral TUI port. */
export function createKlientSessionControlPort(
  runtime: KimiV2Runtime | Klient,
): SessionControlPort {
  const klient = 'klient' in runtime ? runtime.klient : runtime;

  return {
    sessions: {
      list: (input = {}) => listKlientSessions(klient, input),
      create: async (input) => {
        const meta = await klient.global.sessions.create({
          workDir: input.workDir,
          additionalDirs: input.additionalDirs,
          mainAgentBinding: {
            profile: 'agent',
            model: input.model,
            thinking: input.thinking,
            strictThinking: input.thinking === undefined ? undefined : true,
          },
        });
        const agent = klient.session(meta.id).agent(MAIN_AGENT_ID);
        if (input.permission !== undefined) {
          await agent.setPermission(input.permission);
        }
        if (input.planMode === true) {
          await agent.enterPlan();
        }
        return klientMetaIdentity(meta);
      },
      resume: async (input) => {
        const summary = await klient.global.sessions.get(input.id);
        if (summary === undefined) return undefined;
        const session = klient.session(input.id);
        if (!(await session.restore())) return undefined;
        for (const path of input.additionalDirs ?? []) {
          await session.workspace.addAdditionalDir({ path, persist: false });
        }
        return klientMetaIdentity(await session.get());
      },
    },
    session: (sessionId) => createKlientSessionLifecycle(klient.session(sessionId)),
    agent: (sessionId, agentId = MAIN_AGENT_ID) =>
      createKlientAgentControl(klient.session(sessionId).agent(agentId)),
  };
}

function createKlientSessionLifecycle(session: KlientSession): SessionLifecyclePort {
  return {
    getIdentity: async () => klientMetaIdentity(await session.get()),
    close: async () => {
      await session.close();
    },
    setTitle: async (title) => {
      await session.setTitle(title);
    },
    fork: async (input = {}) =>
      klientMetaIdentity(await session.fork({ title: input.title })),
  };
}

async function listKlientSessions(
  klient: Klient,
  input: SessionListInput,
): Promise<readonly SessionIdentity[]> {
  if (input.sessionId !== undefined) {
    const summary = await klient.global.sessions.get(input.sessionId);
    if (
      summary === undefined ||
      (input.includeArchived !== true && summary.archived)
    ) {
      return [];
    }
    if (input.workDir !== undefined) {
      const workspaceIds = await resolveWorkspaceIds(klient, input.workDir);
      if (!workspaceIds.includes(summary.workspaceId)) return [];
    }
    return [klientSummaryIdentity(summary)];
  }

  const workspaceIds =
    input.workDir === undefined
      ? undefined
      : await resolveWorkspaceIds(klient, input.workDir);
  if (workspaceIds?.length === 0) return [];

  const identities: SessionIdentity[] = [];
  let cursor: string | undefined;
  do {
    const page = await klient.global.sessions.list({
      workspaceIds,
      includeArchived: input.includeArchived,
      cursor,
    });
    identities.push(...page.items.map(klientSummaryIdentity));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return identities;
}

async function resolveWorkspaceIds(
  klient: Klient,
  workDir: string,
): Promise<readonly string[]> {
  const workspaces = await klient.global.workspaces.list();
  return workspaces
    .filter((workspace) => workspace.root === workDir)
    .map((workspace) => workspace.id);
}

function createKlientAgentControl(agent: KlientAgent): SessionAgentControlPort {
  return {
    prompt: async (input) => {
      await agent.prompt({ input: normalizePrompt(input) });
    },
    steer: async (input) => {
      await agent.steer({ input: normalizePrompt(input) });
    },
    cancel: async () => {
      await agent.cancel();
    },
    runShellCommand: (command, commandId) =>
      agent.runShellCommand({ command, commandId }),
    cancelShellCommand: async (commandId) => {
      await agent.cancelShellCommand({ commandId });
    },
    getStatus: async () => {
      const [profile, permission, plan, usage, context] = await Promise.all([
        agent.profile.get(),
        agent.getPermission(),
        agent.getPlan(),
        agent.getUsage(),
        agent.getContext(),
      ]);
      const maxContextTokens = profile.modelCapabilities.max_context_tokens;
      const contextTokens = context.tokenCount;
      return {
        model: profile.modelAlias,
        thinkingEffort: profile.thinkingLevel,
        permission,
        planMode: plan !== null,
        contextTokens,
        maxContextTokens,
        contextUsage:
          maxContextTokens > 0 ? contextTokens / maxContextTokens : 0,
        usage,
      };
    },
    getModel: () => agent.getModel(),
    setModel: async (model) => {
      await agent.setModel(model);
    },
    getThinking: async () => (await agent.profile.get()).thinkingLevel,
    setThinking: async (effort) => {
      await agent.profile.setThinking(effort);
    },
    setPermission: async (mode) => {
      await agent.setPermission(mode);
    },
    getPlan: async () => copyPlan(await agent.getPlan()),
    setPlanMode: async (enabled) => {
      if (enabled) {
        await agent.enterPlan();
      } else {
        await agent.cancelPlan();
      }
    },
    clearPlan: async () => {
      await agent.clearPlan();
    },
    getGoal: async () => {
      const goal = await agent.goal.get();
      return goal === null ? null : copyGoal(goal);
    },
    createGoal: async (input) => copyGoal(await agent.goal.create(input)),
    pauseGoal: async () => copyGoal(await agent.goal.pause()),
    resumeGoal: async () => copyGoal(await agent.goal.resume()),
    cancelGoal: async () => copyGoal(await agent.goal.cancel()),
    listTasks: async (input = {}) =>
      (await agent.getTasks({
        activeOnly: input.activeOnly,
        limit: input.limit,
      })).map(copyTask),
    detachTask: async (taskId) => {
      const task = await agent.detachTask({ taskId });
      return task === undefined ? undefined : copyTask(task);
    },
    getTaskOutput: (taskId, tail) => agent.getTaskOutput({ taskId, tail }),
    stopTask: async (taskId, reason) => {
      await agent.stopTask({ taskId, reason });
    },
  };
}

function normalizePrompt(input: AgentPromptInput): readonly AgentPromptPart[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input;
}

function klientSummaryIdentity(summary: KlientSessionSummary): SessionIdentity {
  return {
    id: summary.id,
    workDir: summary.cwd,
    title: summary.title,
    lastPrompt: summary.lastPrompt,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: summary.archived,
    metadata: summary.custom === undefined ? undefined : { ...summary.custom },
  };
}

function klientMetaIdentity(meta: KlientSessionMeta): SessionIdentity {
  return {
    id: meta.id,
    workDir: meta.cwd,
    title: meta.title,
    lastPrompt: meta.lastPrompt,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    archived: meta.archived,
    metadata: meta.custom === undefined ? undefined : { ...meta.custom },
  };
}

/**
 * Narrow the Klient facade's wire payloads to the runtime-neutral DTOs the
 * TUI owns. The Klient memory transport already JSON-clones payloads, but
 * siblings (e.g. the goal-queue adapter) still select only the declared
 * fields so the controller can never observe engine-only additions; these
 * do the same for the agent-control surface.
 */
function copyPlan(plan: Awaited<ReturnType<KlientAgent['getPlan']>>): AgentPlan | null {
  if (plan === null) return null;
  return { id: plan.id, content: plan.content, path: plan.path };
}

function copyGoal(goal: Awaited<ReturnType<KlientAgent['goal']['create']>>): AgentGoal {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    completionCriterion: goal.completionCriterion,
    status: goal.status,
    turnsUsed: goal.turnsUsed,
    tokensUsed: goal.tokensUsed,
    wallClockMs: goal.wallClockMs,
    budget: goal.budget,
    terminalReason: goal.terminalReason,
  };
}

function copyTask(
  task: Awaited<ReturnType<KlientAgent['getTasks']>>[number],
): AgentTask {
  // Kind-specific fields live on separate arms of the discriminated union.
  const kindFields =
    task.kind === 'process'
      ? { command: task.command, pid: task.pid, exitCode: task.exitCode }
      : task.kind === 'agent'
        ? { agentId: task.agentId, subagentType: task.subagentType }
        : { questionCount: task.questionCount, toolCallId: task.toolCallId };
  return {
    taskId: task.taskId,
    kind: task.kind,
    description: task.description,
    status: task.status,
    detached: task.detached,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    stopReason: task.stopReason,
    timeoutMs: task.timeoutMs,
    ...kindFields,
  };
}
