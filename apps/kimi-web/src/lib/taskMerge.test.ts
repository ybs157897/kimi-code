import { describe, expect, it } from 'vitest';

import type { AppTask } from '../api/types';
import { keepLiveSubagents } from './taskMerge';

function task(patch: Partial<AppTask>): AppTask {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    kind: 'subagent',
    description: 'test subagent',
    status: 'running',
    createdAt: new Date(0).toISOString(),
    ...patch,
  };
}

describe('keepLiveSubagents', () => {
  it('folds a REST task into its agent-id-keyed live row', () => {
    const live = task({ id: 'agent-0', runInBackground: false });
    const rest = task({ id: 'agent-task-1', agentId: 'agent-0', status: 'completed' });

    expect(keepLiveSubagents([rest], [live])).toEqual([
      expect.objectContaining({
        id: 'agent-0',
        status: 'completed',
        subagentPhase: 'completed',
        agentId: 'agent-0',
        backgroundTaskId: 'agent-task-1',
      }),
    ]);
  });
});
