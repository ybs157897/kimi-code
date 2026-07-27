/**
 * Scenario: swarm-mode controls cross the bound session-agent TUI runtime boundary.
 * Responsibilities: both adapters report neutral state and route enter/exit to
 * the explicitly selected session and agent. The legacy harness or Klient
 * runtime facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-swarm-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionSwarmPort } from '#/tui/runtime/klient-session-swarm-adapter';
import { createLegacySessionSwarmPort } from '#/tui/runtime/legacy-session-swarm-adapter';

describe('legacy session swarm adapter (bound swarm controls)', () => {
  it('isActive returns true when the selected legacy agent reports swarm mode', async () => {
    const rig = legacyRig({
      getStatus: vi.fn(async () => ({ swarmMode: true })),
    });

    const result = await rig.port.isActive();

    expect(result).toBe(true);
    expect(rig.harness.getSession).toHaveBeenCalledWith('session-1');
    expect(rig.selectedAgentIds).toEqual(['worker']);
  });

  it('isActive returns false when legacy swarm status is absent', async () => {
    const rig = legacyRig({
      getStatus: vi.fn(async () => ({})),
    });

    const result = await rig.port.isActive();

    expect(result).toBe(false);
  });

  it('enter enables legacy swarm mode with the requested trigger', async () => {
    const setSwarmMode = vi.fn(async () => undefined);
    const rig = legacyRig({ setSwarmMode });

    await rig.port.enter('task');

    expect(setSwarmMode).toHaveBeenCalledWith(true, 'task');
  });

  it('exit disables legacy swarm mode through the bound agent', async () => {
    const setSwarmMode = vi.fn(async () => undefined);
    const rig = legacyRig({ setSwarmMode });

    await rig.port.exit();

    expect(setSwarmMode).toHaveBeenCalledWith(false, 'manual');
    expect(rig.selectedAgentIds).toEqual(['worker']);
  });
});

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

function legacyRig(
  overrides: Partial<{
    getStatus: () => Promise<{ readonly swarmMode?: boolean }>;
    setSwarmMode: (
      enabled: boolean,
      trigger: 'manual' | 'task' | 'tool',
    ) => Promise<void>;
  }> = {},
) {
  const session = {
    getStatus: overrides.getStatus ?? vi.fn(async () => ({ swarmMode: false })),
    setSwarmMode:
      overrides.setSwarmMode ?? vi.fn(async () => undefined),
  };
  const selectedAgentIds: string[] = [];
  const harness = {
    getSession: vi.fn((_sessionId: string) => session),
    withInteractiveAgent<T>(agentId: string, operation: () => T): T {
      selectedAgentIds.push(agentId);
      return operation();
    },
  };
  return {
    harness,
    selectedAgentIds,
    session,
    port: createLegacySessionSwarmPort(
      harness,
      'session-1',
      'worker',
    ),
  };
}

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
