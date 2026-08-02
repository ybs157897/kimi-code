// ProductProjector tests — subagent transcript → task progress projection and
// background-subagent task id consistency. Uses a fake klient whose agent event
// hubs record listeners, so the projector's wiring can be exercised without an
// engine. Run with `pnpm --filter @moonshot-ai/kimi-desktop test:sidecar`.

import { describe, expect, it } from 'vitest';

import type { IDisposable, Klient } from '@moonshot-ai/klient';

import { ProductProjector } from './projector.js';
import type { WireEvent } from './wire.js';

type Listener = (payload: unknown) => void;

class FakeEventHub {
  readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): IDisposable {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return {
      dispose: () => {
        set.delete(listener);
      },
    };
  }

  emit(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(payload);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeAgent {
  readonly events = new FakeEventHub();
  constructor(readonly id: string) {}
}

class FakeSession {
  readonly registry = new Map<string, FakeAgent>();
  readonly events = new FakeEventHub();

  agent(id: string): FakeAgent {
    let agent = this.registry.get(id);
    if (agent === undefined) {
      agent = new FakeAgent(id);
      this.registry.set(id, agent);
    }
    return agent;
  }

  /** Mirrors the klient session facade's `agents()` metadata registry read. */
  async agents(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const id of this.registry.keys()) out[id] = { type: id === 'main' ? 'main' : 'sub' };
    return out;
  }
}

class FakeKlient {
  readonly sessions = new Map<string, FakeSession>();

  session(id: string): FakeSession {
    let session = this.sessions.get(id);
    if (session === undefined) {
      session = new FakeSession();
      this.sessions.set(id, session);
    }
    return session;
  }
}

function connect(): {
  klient: FakeKlient;
  pushed: WireEvent[];
  dispose: () => void;
} {
  const klient = new FakeKlient();
  const projector = new ProductProjector(klient as unknown as Klient);
  const pushed: WireEvent[] = [];
  const sub = projector.subscribe('s-1', 'main', (event) => {
    pushed.push(event);
  });
  return {
    klient,
    pushed,
    dispose: () => sub.dispose(),
  };
}

function spawnSubagent(
  klient: FakeKlient,
  subagentId = 'sub-1',
  description = 'Sub Agent',
): void {
  klient.session('s-1').agent('main').events.emit('subagent.spawned', {
    type: 'subagent.spawned',
    subagentId,
    subagentName: 'Summarizer',
    parentToolCallId: 'tc-1',
    description,
    runInBackground: false,
  });
}

describe('ProductProjector subagent transcript projection', () => {
  it('attaches transcript subscriptions for subagents recovered at subscribe time', async () => {
    const klient = new FakeKlient();
    // A subagent already exists in the session (restored / persisted) before
    // the client subscribes — its `subagent.spawned` never re-broadcasts, so
    // only the recovery sweep can attach its transcript subscription.
    const subEvents = klient.session('s-1').agent('sub-1').events;

    const projector = new ProductProjector(klient as unknown as Klient);
    const pushed: WireEvent[] = [];
    const sub = projector.subscribe('s-1', 'main', (event) => {
      pushed.push(event);
    });

    // Flush the recovery sweep's async metadata read.
    await Promise.resolve();
    await Promise.resolve();

    expect(subEvents.listenerCount('thinking.delta')).toBe(1);
    expect(subEvents.listenerCount('assistant.delta')).toBe(1);

    subEvents.emit('thinking.delta', { type: 'thinking.delta', delta: 'recovered thinking' });
    const progress = pushed.filter((e) => e.type === 'event.task.progress') as Array<
      WireEvent & { payload: { task_id: string; kind?: string; output_chunk: string } }
    >;
    expect(progress).toHaveLength(1);
    expect(progress[0]!.payload.task_id).toBe('sub-1');
    expect(progress[0]!.payload.kind).toBe('thinking');
    expect(progress[0]!.payload.output_chunk).toBe('recovered thinking');

    sub.dispose();
  });

  it('attaches a per-subagent subscription and folds its frames into task.progress', () => {
    const { klient, pushed, dispose } = connect();
    spawnSubagent(klient, 'sub-1', '补齐5个萃取引擎文件摘要');

    // The subagent's own event hub now has the transcript listeners.
    const subEvents = klient.session('s-1').agent('sub-1').events;
    expect(subEvents.listenerCount('thinking.delta')).toBe(1);
    expect(subEvents.listenerCount('assistant.delta')).toBe(1);
    expect(subEvents.listenerCount('tool.call.started')).toBe(1);
    expect(subEvents.listenerCount('tool.progress')).toBe(1);

    // The spawned task row was emitted with the real description.
    const created = pushed.find((e) => e.type === 'event.task.created') as
      | { payload: { task: { id: string; description: string } } }
      | undefined;
    expect(created?.payload.task.id).toBe('sub-1');
    expect(created?.payload.task.description).toBe('补齐5个萃取引擎文件摘要');

    // thinking / assistant deltas project with kind so the reducer concatenates.
    subEvents.emit('thinking.delta', { type: 'thinking.delta', delta: 'thinking…' });
    subEvents.emit('assistant.delta', { type: 'assistant.delta', delta: 'Hello' });

    // Tool frames project as progress lines (trailing _N tool name stripped).
    subEvents.emit('tool.call.started', {
      type: 'tool.call.started',
      toolCallId: 'tc-2',
      name: 'Read_0',
      args: { path: '/a.txt' },
    });
    subEvents.emit('tool.progress', {
      type: 'tool.progress',
      toolCallId: 'tc-2',
      update: { text: 'scanning…', kind: 'stdout' },
    });

    const progress = pushed.filter((e) => e.type === 'event.task.progress') as Array<
      WireEvent & { payload: { task_id: string; output_chunk: string; kind?: string } }
    >;
    expect(progress.map((p) => [p.payload.task_id, p.payload.kind])).toEqual([
      ['sub-1', 'thinking'],
      ['sub-1', 'text'],
      ['sub-1', 'line'],
      ['sub-1', 'line'],
    ]);
    expect(progress[0]!.payload.output_chunk).toBe('thinking…');
    expect(progress[1]!.payload.output_chunk).toBe('Hello');
    expect(progress[2]!.payload.output_chunk).toBe('Calling Read');
    expect(progress[3]!.payload.output_chunk).toBe('scanning…');

    dispose();
  });

  it('detaches the subagent subscription on completion', () => {
    const { klient, dispose } = connect();
    spawnSubagent(klient, 'sub-1');
    const subEvents = klient.session('s-1').agent('sub-1').events;
    expect(subEvents.listenerCount('thinking.delta')).toBe(1);

    klient.session('s-1').agent('main').events.emit('subagent.completed', {
      type: 'subagent.completed',
      subagentId: 'sub-1',
      resultSummary: 'done',
    });

    // The transcript subscription is released once the subagent finishes.
    expect(subEvents.listenerCount('thinking.delta')).toBe(0);
    expect(subEvents.listenerCount('tool.call.started')).toBe(0);

    dispose();
  });

  it('emits task.completed against the AGENT id for background subagents', () => {
    const { klient, pushed, dispose } = connect();
    const mainEvents = klient.session('s-1').agent('main').events;

    // task.started for a background subagent keys the row by agentId AND
    // attaches its transcript subscription (idempotent with spawned).
    mainEvents.emit('task.started', {
      type: 'task.started',
      info: {
        taskId: 'task-1',
        kind: 'agent',
        agentId: 'sub-1',
        description: 'bg subagent',
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        detached: true,
      },
    });
    const subEvents = klient.session('s-1').agent('sub-1').events;
    expect(subEvents.listenerCount('thinking.delta')).toBe(1);

    // task.terminated carries the registry taskId — the completed frame must
    // still target the agentId-keyed row, otherwise the UI can never settle it.
    mainEvents.emit('task.terminated', {
      type: 'task.terminated',
      info: {
        taskId: 'task-1',
        kind: 'agent',
        agentId: 'sub-1',
        description: 'bg subagent',
        status: 'completed',
        startedAt: Date.now(),
        endedAt: Date.now(),
        detached: true,
        exitCode: 0,
      },
    });

    const completed = pushed.filter((e) => e.type === 'event.task.completed') as Array<
      WireEvent & { payload: { task_id: string; status: string } }
    >;
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload.task_id).toBe('sub-1');
    expect(completed[0]!.payload.status).toBe('completed');

    // The finished background subagent's transcript subscription is released.
    expect(subEvents.listenerCount('thinking.delta')).toBe(0);

    dispose();
  });

  it('keeps the bash task id for non-agent tasks', () => {
    const { klient, pushed, dispose } = connect();
    const mainEvents = klient.session('s-1').agent('main').events;

    mainEvents.emit('task.started', {
      type: 'task.started',
      info: {
        taskId: 'bash-1',
        kind: 'process',
        command: 'npm test',
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        detached: true,
      },
    });
    mainEvents.emit('task.terminated', {
      type: 'task.terminated',
      info: {
        taskId: 'bash-1',
        kind: 'process',
        command: 'npm test',
        status: 'completed',
        startedAt: Date.now(),
        endedAt: Date.now(),
        detached: true,
        exitCode: 0,
      },
    });

    const completed = pushed.filter((e) => e.type === 'event.task.completed') as Array<
      WireEvent & { payload: { task_id: string } }
    >;
    expect(completed[0]!.payload.task_id).toBe('bash-1');

    dispose();
  });
});
