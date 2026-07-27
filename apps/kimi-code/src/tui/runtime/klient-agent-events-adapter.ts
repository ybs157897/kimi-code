import type { KimiV2Runtime } from '@moonshot-ai/kimi-code-sdk/v2';

import type {
  AgentEventsPort,
  TUIAgentEvent,
  TUIAgentEventListener,
  TUIAgentEventType,
} from './agent-events-port';
import {
  projectTUIAgentReplay,
  type TUIAgentReplaySource,
} from './agent-replay';

type KlientFacade = KimiV2Runtime['klient'];
type KlientSessionFacade = ReturnType<KlientFacade['session']>;
type KlientAgentFacade = ReturnType<KlientSessionFacade['agent']>;
type KlientDisposable = ReturnType<KlientAgentFacade['events']['onError']>;

/** Bind one Klient agent scope to the runtime-neutral TUI event port. */
export function createKlientAgentEventsPort(
  session: KlientSessionFacade,
  sessionId: string,
  agentId = 'main',
): AgentEventsPort {
  const listeners = new Set<TUIAgentEventListener>();
  const disposables: KlientDisposable[] = [];
  const agent = session.agent(agentId);

  const emit = (event: object & { readonly type: TUIAgentEventType }): void => {
    const normalized = { ...event, sessionId, agentId } as TUIAgentEvent;
    for (const listener of listeners) listener(normalized);
  };

  const connect = (): void => {
    disposables.push(
      agent.events.on('turn.started', (event) => {
        emit(event);
      }),
      agent.events.on('turn.ended', (event) => {
        emit(event);
      }),
      agent.events.on('turn.step.started', (event) => {
        emit(event);
      }),
      agent.events.on('turn.step.retrying', (event) => {
        emit(event);
      }),
      agent.events.on('turn.step.interrupted', (event) => {
        emit(event);
      }),
      agent.events.on('turn.step.completed', (event) => {
        emit(event);
      }),
      agent.events.on('assistant.delta', (event) => {
        emit(event);
      }),
      agent.events.on('hook.result', (event) => {
        emit(event);
      }),
      agent.events.on('thinking.delta', (event) => {
        emit(event);
      }),
      agent.events.on('tool.call.delta', (event) => {
        emit(event);
      }),
      agent.events.on('tool.call.started', (event) => {
        emit(event);
      }),
      agent.events.on('tool.progress', (event) => {
        emit(event);
      }),
      agent.events.on('shell.output', (event) => {
        emit(event);
      }),
      agent.events.on('shell.started', (event) => {
        emit(event);
      }),
      agent.events.on('tool.result', (event) => {
        emit(event);
      }),
      agent.events.on('prompt.completed', (event) => {
        emit(event);
      }),
      agent.events.on('prompt.aborted', (event) => {
        emit(event);
      }),
      agent.events.on('goal.updated', (event) => {
        emit(event);
      }),
      agent.events.on('skill.activated', (event) => {
        emit(event);
      }),
      agent.events.on('plugin_command.activated', (event) => {
        emit(event);
      }),
      agent.events.on('error', (event) => {
        emit({ ...event, type: 'error' });
      }),
      agent.events.on('warning', (event) => {
        emit(event);
      }),
      agent.events.on('notice', (event) => {
        emit(event);
      }),
      agent.events.on('agent.status.updated', (event) => {
        emit({ ...event, type: 'agent.status.updated' });
      }),
      agent.events.on('compaction.started', (event) => {
        emit(event);
      }),
      agent.events.on('compaction.blocked', (event) => {
        emit(event);
      }),
      agent.events.on('compaction.cancelled', (event) => {
        emit(event);
      }),
      agent.events.on('compaction.completed', (event) => {
        emit(event);
      }),
      agent.events.on('subagent.spawned', (event) => {
        emit(event);
      }),
      agent.events.on('subagent.started', (event) => {
        emit(event);
      }),
      agent.events.on('subagent.suspended', (event) => {
        emit(event);
      }),
      agent.events.on('subagent.completed', (event) => {
        emit(event);
      }),
      agent.events.on('subagent.failed', (event) => {
        emit(event);
      }),
      agent.events.on('task.started', (event) => {
        emit({ ...event, type: 'background.task.started' });
      }),
      agent.events.on('task.terminated', (event) => {
        emit({ ...event, type: 'background.task.terminated' });
      }),
      agent.events.on('cron.fired', (event) => {
        emit(event);
      }),
      agent.events.on('mcp.server.status', (event) => {
        emit(event);
      }),
      agent.events.on('tool.list.updated', (event) => {
        emit(event);
      }),
    );
  };

  const disconnect = (): void => {
    for (const disposable of disposables.splice(0)) disposable.dispose();
  };

  return {
    sessionId,
    agentId,

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

    async readReplay() {
      const replay = await agent.replay.read();
      return projectTUIAgentReplay(
        replay as TUIAgentReplaySource,
      );
    },
  };
}
