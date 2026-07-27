import { describe, expect, it } from 'vitest';

import type { AgentTask } from '#/tui/runtime/session-control-port';
import { formatBackgroundTaskTranscript } from '@/tui/utils/background-task-status';

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  const taskId = overrides.taskId ?? 'bash-abcd1234';
  const kind = overrides.kind ?? (taskId.startsWith('agent-') ? 'agent' : 'process');
  return {
    taskId,
    kind,
    description: 'dev server',
    status: 'running',
    startedAt: Date.now() - 1000,
    endedAt: null,
    ...overrides,
  };
}

describe('formatBackgroundTaskTranscript', () => {
  it('renders a bash started entry', () => {
    const data = formatBackgroundTaskTranscript(task({ status: 'running' }));
    expect(data).toEqual({
      phase: 'started',
      headline: 'bash task started in background',
      detail: 'dev server',
    });
  });

  it('renders an agent started entry', () => {
    const data = formatBackgroundTaskTranscript(
      task({ taskId: 'agent-deadbeef', status: 'running' }),
    );
    expect(data).toEqual({
      phase: 'started',
      headline: 'agent task started in background',
      detail: 'dev server',
    });
  });

  it('renders a question started entry', () => {
    const data = formatBackgroundTaskTranscript(
      task({
        taskId: 'question-deadbeef',
        kind: 'question',
        questionCount: 1,
        status: 'running',
      }),
    );
    expect(data).toEqual({
      phase: 'started',
      headline: 'question task started in background',
      detail: 'dev server',
    });
  });

  it('renders a completed entry with exit code in detail', () => {
    const data = formatBackgroundTaskTranscript(
      task({ status: 'completed', exitCode: 0, endedAt: Date.now() }),
    );
    expect(data).toEqual({
      phase: 'completed',
      headline: 'bash task completed in background',
      detail: 'dev server · exit 0',
    });
  });

  it('renders a failed entry with non-zero exit and stop reason', () => {
    const data = formatBackgroundTaskTranscript(
      task({
        status: 'failed',
        exitCode: 2,
        stopReason: 'process failed',
        endedAt: Date.now(),
      }),
    );
    expect(data).toEqual({
      phase: 'failed',
      headline: 'bash task failed in background',
      detail: 'dev server · exit 2 · process failed',
    });
  });

  it('renders a killed entry with stop reason', () => {
    const data = formatBackgroundTaskTranscript(
      task({ status: 'killed', stopReason: 'user', endedAt: Date.now() }),
    );
    expect(data).toEqual({
      phase: 'failed',
      headline: 'bash task stopped',
      detail: 'dev server · stopped — user',
    });
  });

  it('renders a lost entry with restart note', () => {
    const data = formatBackgroundTaskTranscript(task({ status: 'lost', endedAt: Date.now() }));
    expect(data).toEqual({
      phase: 'failed',
      headline: 'bash task lost',
      detail: 'dev server · session restarted before completion',
    });
  });

  it('surfaces timeout stop reason for agent deadlines', () => {
    const data = formatBackgroundTaskTranscript(
      task({
        taskId: 'agent-aaaaaaaa',
        status: 'timed_out',
        endedAt: Date.now(),
      }),
    );
    expect(data).toEqual({
      phase: 'failed',
      headline: 'agent task timed out',
      detail: 'dev server · timed out',
    });
  });

  it('collapses and truncates long detail text', () => {
    const data = formatBackgroundTaskTranscript(
      task({ description: `  ${'a'.repeat(120)}   ${'b'.repeat(121)}  ` }),
    );
    expect(data.detail).toBe(`${'a'.repeat(120)} ${'b'.repeat(116)}...`);
  });
});
