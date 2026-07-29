/**
 * Scenario: context mutations for one active session-agent pair cross the TUI
 * runtime boundary. Responsibilities: the adapter exposes compact,
 * cancellation, and history undo with their documented result semantics.
 * Wiring: a small Klient agent facade is the only stub.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-context-control-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionContextControlPort } from '#/tui/runtime/klient-session-context-control-adapter';

describe('Klient session context control adapter', () => {
  it('returns the compact result from the selected agent when instructed', async () => {
    const compact = vi.fn(async () => false);
    const session = klientSession(klientAgent({ compact }));
    const port = createKlientSessionContextControlPort(session, 'worker');

    const result = await port.compact({ instruction: 'Keep decisions.' });

    expect(result).toBe(false);
    expect(session.agent).toHaveBeenCalledWith('worker');
    expect(compact).toHaveBeenCalledWith({ instruction: 'Keep decisions.' });
  });

  it('delegates cancellation when the selected agent is compacting', async () => {
    const cancelCompaction = vi.fn(async () => undefined);
    const port = createKlientSessionContextControlPort(
      klientSession(klientAgent({ cancelCompaction })),
      'worker',
    );

    await port.cancelCompaction();

    expect(cancelCompaction).toHaveBeenCalledOnce();
  });

  it('discards the removed count when undoHistory completes', async () => {
    const undoHistory = vi.fn(async () => 3);
    const port = createKlientSessionContextControlPort(
      klientSession(klientAgent({ undoHistory })),
      'worker',
    );

    const result = await (port.undoHistory(3) as Promise<unknown>);

    expect(result).toBeUndefined();
    expect(undoHistory).toHaveBeenCalledWith(3);
  });
});

function klientAgent(
  overrides: Partial<{
    compact: (input?: { instruction?: string }) => Promise<boolean>;
    cancelCompaction: () => Promise<void>;
    undoHistory: (count?: number) => Promise<number>;
  }> = {},
) {
  return {
    compact: vi.fn(async () => true),
    cancelCompaction: vi.fn(async () => undefined),
    undoHistory: vi.fn(async () => 0),
    ...overrides,
  };
}

function klientSession(agent: ReturnType<typeof klientAgent>) {
  return {
    agent: vi.fn((_agentId: string) => agent),
  };
}
