/**
 * Scenario: swarm-mode controls cross the bound session-agent TUI runtime boundary.
 * The Klient adapter reports neutral state and routes enter/exit to the explicitly
 * selected session and agent. The runtime facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-swarm-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionSwarmPort } from '#/tui/runtime/klient-session-swarm-adapter';

describe('Klient session swarm adapter (bound swarm controls)', () => {
  it('isActive returns the selected Klient agent swarm state', async () => {
    const rig = klientRig({
      isActive: vi.fn(async () => true),
    });

    const result = await rig.port.isActive();

    expect(result).toBe(true);
    expect(rig.klient.session).toHaveBeenCalledWith('session-2');
    expect(rig.session.agent).toHaveBeenCalledWith('reviewer');
  });

  it('enter forwards the requested trigger to the selected Klient agent', async () => {
    const enter = vi.fn(async () => undefined);
    const rig = klientRig({ enter });

    await rig.port.enter('tool');

    expect(enter).toHaveBeenCalledWith('tool');
  });

  it('exit leaves swarm mode through the selected Klient agent', async () => {
    const exit = vi.fn(async () => undefined);
    const rig = klientRig({ exit });

    await rig.port.exit();

    expect(exit).toHaveBeenCalledOnce();
  });
});

function klientRig(
  overrides: Partial<{
    isActive: () => Promise<boolean>;
    enter: (trigger: 'manual' | 'task' | 'tool') => Promise<void>;
    exit: () => Promise<void>;
  }> = {},
) {
  const swarm = {
    isActive: overrides.isActive ?? vi.fn(async () => false),
    enter: overrides.enter ?? vi.fn(async () => undefined),
    exit: overrides.exit ?? vi.fn(async () => undefined),
  };
  const session = {
    agent: vi.fn((_agentId: string) => ({ swarm })),
  };
  const klient = {
    session: vi.fn((_sessionId: string) => session),
  };
  return {
    klient,
    session,
    swarm,
    port: createKlientSessionSwarmPort(
      { klient },
      'session-2',
      'reviewer',
    ),
  };
}
