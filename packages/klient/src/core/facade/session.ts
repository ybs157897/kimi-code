/**
 * The session facade — one `klient.session(id)` handle aggregating the
 * session-scope services (metadata, activity, approvals, questions,
 * interactions) plus the app-scope lifecycle service for close/archive/
 * restore/fork/createChild. `agents()` reads the metadata registry (agent
 * handles are not serializable, so no agent-lifecycle channel exists on the
 * wire).
 */

import type { AgentActivityState } from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import type {
  AgentMeta,
  SessionMeta,
  SessionMetaPatch,
} from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type {
  ApprovalRequest,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/session/approval/approval';
import type {
  QuestionRequest,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/session/question/question';
import type {
  Interaction,
  InteractionKind,
} from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import type {
  ExpertTeamDefinition,
  ExpertTeamSnapshot,
} from '@moonshot-ai/agent-core-v2/session/expertTeam/expertTeam';
import type { CronTask } from '@moonshot-ai/agent-core-v2/app/cron/cronTask';
import type {
  GoalQueueMoveDirection,
  GoalQueueSnapshot,
  UpcomingGoal,
} from '@moonshot-ai/agent-core-v2/session/goalQueue/sessionGoalQueue';
import type { ExtensionReloadSummary } from '@moonshot-ai/agent-core-v2/session/extension/sessionExtension';
import type { ExtensionCommandDefinition } from '@moonshot-ai/agent-core-v2/app/extension/extension.types';
import type { SkillSummary } from '@moonshot-ai/agent-core-v2/app/skillCatalog/types';
import type {
  AddAdditionalDirInput,
  WorkspaceAdditionalDirsResult,
} from '@moonshot-ai/agent-core-v2/session/workspaceCommand/workspaceCommand';
import type { TodoItem } from '@moonshot-ai/agent-core-v2/session/todo/todoItem';

import type { ScopeRef } from '../channel.js';
import type { ScopedCaller } from './global.js';

export type { ScopedCaller } from './global.js';

/** What `sessionLifecycleService.create/fork/createChild` leaves on the wire. */
interface HandleWire {
  readonly id: string;
}

export interface SessionApprovalsFacade {
  list(): Promise<readonly ApprovalRequest[]>;
  decide(id: string, response: ApprovalResponse): Promise<void>;
}

export interface SessionQuestionsFacade {
  list(): Promise<readonly QuestionRequest[]>;
  answer(id: string, result: QuestionResult): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export interface SessionInteractionsFacade {
  list(kind?: InteractionKind): Promise<readonly Interaction[]>;
  respond(id: string, response: unknown): Promise<void>;
}

export interface SessionInitFacade {
  generateAgentsMd(): Promise<void>;
  cancel(): Promise<void>;
}

export interface SessionBtwFacade {
  start(): Promise<string>;
}

export interface SessionExpertTeamFacade {
  list(): Promise<readonly ExpertTeamDefinition[]>;
  get(): Promise<ExpertTeamSnapshot | null>;
  activate(pluginId: string): Promise<ExpertTeamSnapshot>;
  deactivate(): Promise<void>;
}

export interface SessionExtensionsFacade {
  listCommands(): Promise<readonly ExtensionCommandDefinition[]>;
  reload(): Promise<ExtensionReloadSummary>;
}

export interface SessionCronFacade {
  list(): Promise<readonly CronTask[]>;
  getNextFireTime(): Promise<number | null>;
  getNextFireForTask(taskId: string): Promise<number | null>;
}

export interface SessionGoalQueueFacade {
  read(): Promise<GoalQueueSnapshot>;
  append(input: { readonly objective: string }): Promise<GoalQueueSnapshot>;
  update(input: {
    readonly goalId: string;
    readonly objective: string;
  }): Promise<GoalQueueSnapshot>;
  remove(input: { readonly goalId: string }): Promise<GoalQueueSnapshot>;
  restore(goal: UpcomingGoal): Promise<GoalQueueSnapshot>;
  move(input: {
    readonly goalId: string;
    readonly direction: GoalQueueMoveDirection;
  }): Promise<GoalQueueSnapshot>;
}

export interface SessionSkillsFacade {
  list(): Promise<readonly SkillSummary[]>;
  reload(): Promise<void>;
}

export interface SessionWarning {
  readonly code: string;
  readonly message: string;
}

export interface SessionWarningsFacade {
  list(): Promise<readonly SessionWarning[]>;
}

export interface SessionWorkspaceFacade {
  get(): Promise<{
    readonly workDir: string;
    readonly additionalDirs: readonly string[];
  }>;
  addAdditionalDir(input: AddAdditionalDirInput): Promise<WorkspaceAdditionalDirsResult>;
}

export interface SessionTodoFacade {
  list(): Promise<readonly TodoItem[]>;
  replace(todos: readonly TodoItem[]): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Derived session lifecycle phase. The engine retired its `sessionActivity`
 * service (#1751) — busy is now derived from agent activity views — so the
 * facade composes the phase from the pending interaction lists and each
 * agent's `agentActivityView`, keeping the retired service's precedence.
 */
export type SessionStatus = 'running' | 'idle' | 'awaiting_approval' | 'awaiting_question';

export interface SessionFacade {
  get(): Promise<SessionMeta>;
  setTitle(title: string): Promise<void>;
  update(patch: SessionMetaPatch): Promise<void>;
  setArchived(archived: boolean): Promise<void>;
  status(): Promise<SessionStatus>;
  close(): Promise<void>;
  archive(): Promise<void>;
  /** Re-materialize a closed session; `false` when it no longer exists. */
  restore(): Promise<boolean>;
  fork(input?: {
    newSessionId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    userVisibleTurnIndex?: number;
  }): Promise<SessionMeta>;
  createChild(input?: {
    newSessionId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionMeta>;
  readonly approvals: SessionApprovalsFacade;
  readonly questions: SessionQuestionsFacade;
  readonly interactions: SessionInteractionsFacade;
  readonly init: SessionInitFacade;
  readonly btw: SessionBtwFacade;
  readonly expertTeam: SessionExpertTeamFacade;
  readonly extensions: SessionExtensionsFacade;
  readonly cron: SessionCronFacade;
  readonly goalQueue: SessionGoalQueueFacade;
  readonly skills: SessionSkillsFacade;
  readonly warnings: SessionWarningsFacade;
  readonly workspace: SessionWorkspaceFacade;
  readonly todos: SessionTodoFacade;
  /** Agent id → metadata for every agent registered in this session. */
  agents(): Promise<Readonly<Record<string, AgentMeta>>>;
}

export function createSessionFacade(call: ScopedCaller, sessionId: string): SessionFacade {
  const scope: ScopeRef = { sessionId };
  const read = (): Promise<SessionMeta> =>
    call(scope, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  const spawn = async (
    method: 'fork' | 'createChild',
    input: {
      newSessionId?: string;
      title?: string;
      metadata?: Record<string, unknown>;
      userVisibleTurnIndex?: number;
    } = {},
  ): Promise<SessionMeta> => {
    const handle = (await call({}, 'sessionLifecycleService', method, [
      {
        sourceSessionId: sessionId,
        newSessionId: input.newSessionId,
        title: input.title,
        metadata: input.metadata,
        userVisibleTurnIndex: input.userVisibleTurnIndex,
      },
    ])) as HandleWire;
    return call({ sessionId: handle.id }, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  };

  return {
    get: read,
    setTitle: (title) => call(scope, 'sessionMetadata', 'setTitle', [title]) as Promise<void>,
    update: (patch) => call(scope, 'sessionMetadata', 'update', [patch]) as Promise<void>,
    setArchived: (archived) =>
      call(scope, 'sessionMetadata', 'setArchived', [archived]) as Promise<void>,
    status: async () => {
      const pending = (kind: 'approval' | 'question') =>
        call(scope, 'sessionInteractionService', 'listPending', [kind]) as Promise<
          readonly unknown[]
        >;
      if ((await pending('approval')).length > 0) return 'awaiting_approval';
      if ((await pending('question')).length > 0) return 'awaiting_question';
      const meta = await read();
      for (const agentId of Object.keys(meta.agents ?? {})) {
        try {
          const state = (await call(
            { sessionId, agentId },
            'agentActivityView',
            'state',
            [],
          )) as AgentActivityState;
          if (state.turn !== undefined || state.background.length > 0) return 'running';
        } catch {
          // Agents stay registered after their live handle is gone; the scope
          // probe fails for a dead agent, so treat it as not active — the same
          // view the retired service had from iterating live handles only.
        }
      }
      return 'idle';
    },
    close: () => call({}, 'sessionLifecycleService', 'close', [sessionId]) as Promise<void>,
    archive: () => call({}, 'sessionLifecycleService', 'archive', [sessionId]) as Promise<void>,
    restore: async () => {
      const handle = (await call({}, 'sessionLifecycleService', 'restore', [
        sessionId,
      ])) as HandleWire | null;
      return handle !== null;
    },
    fork: (input) => spawn('fork', input),
    createChild: (input) => spawn('createChild', input),

    approvals: {
      list: () =>
        call(scope, 'sessionApprovalService', 'listPending', []) as Promise<
          readonly ApprovalRequest[]
        >,
      decide: (id, response) =>
        call(scope, 'sessionApprovalService', 'decide', [id, response]) as Promise<void>,
    },

    questions: {
      list: () =>
        call(scope, 'sessionQuestionService', 'listPending', []) as Promise<
          readonly QuestionRequest[]
        >,
      answer: (id, result) =>
        call(scope, 'sessionQuestionService', 'answer', [id, result]) as Promise<void>,
      dismiss: (id) => call(scope, 'sessionQuestionService', 'dismiss', [id]) as Promise<void>,
    },

    interactions: {
      list: (kind) =>
        call(scope, 'sessionInteractionService', 'listPending', [kind]) as Promise<
          readonly Interaction[]
        >,
      respond: (id, response) =>
        call(scope, 'sessionInteractionService', 'respond', [id, response]) as Promise<void>,
    },

    init: {
      generateAgentsMd: () =>
        call(scope, 'sessionInitService', 'generateAgentsMd', []) as Promise<void>,
      cancel: () => call(scope, 'sessionInitService', 'cancelInit', []) as Promise<void>,
    },

    btw: {
      start: () => call(scope, 'sessionBtwService', 'start', []) as Promise<string>,
    },

    expertTeam: {
      list: () =>
        call(scope, 'sessionExpertTeamService', 'listAvailable', []) as Promise<
          readonly ExpertTeamDefinition[]
        >,
      get: () =>
        call(scope, 'sessionExpertTeamService', 'snapshot', []) as Promise<
          ExpertTeamSnapshot | null
        >,
      activate: (pluginId) =>
        call(scope, 'sessionExpertTeamService', 'activate', [
          pluginId,
        ]) as Promise<ExpertTeamSnapshot>,
      deactivate: () =>
        call(scope, 'sessionExpertTeamService', 'deactivate', []) as Promise<void>,
    },

    extensions: {
      listCommands: () =>
        call(scope, 'sessionExtensionService', 'listCommands', []) as Promise<
          readonly ExtensionCommandDefinition[]
        >,
      reload: () =>
        call(scope, 'sessionExtensionService', 'reload', []) as Promise<ExtensionReloadSummary>,
    },

    cron: {
      list: () =>
        call(scope, 'sessionCronService', 'list', []) as Promise<readonly CronTask[]>,
      getNextFireTime: () =>
        call(scope, 'sessionCronService', 'getNextFireTime', []) as Promise<number | null>,
      getNextFireForTask: (taskId) =>
        call(scope, 'sessionCronService', 'getNextFireForTask', [
          taskId,
        ]) as Promise<number | null>,
    },

    goalQueue: {
      read: () =>
        call(scope, 'sessionGoalQueueService', 'read', []) as Promise<GoalQueueSnapshot>,
      append: (input) =>
        call(scope, 'sessionGoalQueueService', 'append', [input]) as Promise<GoalQueueSnapshot>,
      update: (input) =>
        call(scope, 'sessionGoalQueueService', 'update', [input]) as Promise<GoalQueueSnapshot>,
      remove: (input) =>
        call(scope, 'sessionGoalQueueService', 'remove', [input]) as Promise<GoalQueueSnapshot>,
      restore: (goal) =>
        call(scope, 'sessionGoalQueueService', 'restore', [goal]) as Promise<GoalQueueSnapshot>,
      move: (input) =>
        call(scope, 'sessionGoalQueueService', 'move', [input]) as Promise<GoalQueueSnapshot>,
    },

    skills: {
      list: () =>
        call(scope, 'sessionSkillCatalog', 'listSkills', []) as Promise<
          readonly SkillSummary[]
        >,
      reload: () => call(scope, 'sessionSkillCatalog', 'reload', []) as Promise<void>,
    },

    warnings: {
      list: async () => {
        const warning = (await call(
          scope,
          'sessionSecondaryModelWarningService',
          'getSecondaryModelWarning',
          [],
        )) as SessionWarning | undefined;
        return warning === undefined ? [] : [warning];
      },
    },

    workspace: {
      get: async () => {
        const [workDir, additionalDirs] = await Promise.all([
          call(scope, 'sessionWorkspaceContext', 'workDir', []) as Promise<string>,
          call(scope, 'sessionWorkspaceContext', 'additionalDirs', []) as Promise<
            readonly string[]
          >,
        ]);
        return { workDir, additionalDirs };
      },
      addAdditionalDir: (input) =>
        call(scope, 'sessionWorkspaceCommandService', 'addAdditionalDir', [
          input,
        ]) as Promise<WorkspaceAdditionalDirsResult>,
    },

    todos: {
      list: () =>
        call(scope, 'sessionTodoService', 'getTodos', []) as Promise<readonly TodoItem[]>,
      replace: (todos) =>
        call(scope, 'sessionTodoService', 'setTodos', [todos]) as Promise<void>,
      clear: () => call(scope, 'sessionTodoService', 'clear', []) as Promise<void>,
    },

    agents: async () => {
      const meta = await read();
      return meta.agents ?? {};
    },
  };
}
