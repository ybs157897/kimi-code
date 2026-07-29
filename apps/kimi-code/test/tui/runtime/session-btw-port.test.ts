/**
 * Scenario: starting a side agent crosses the active-session TUI runtime boundary.
 * Responsibilities: both adapters route start to their session facade and
 * return the neutral child agent ID. Follow-up agent operations are outside
 * this port, and each session facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-btw-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionBtwPort } from '#/tui/runtime/klient-session-btw-adapter';

describe('session BTW runtime port (adapter contract)', () => {
  it('Klient start returns the child agent ID from session.btw.start', async () => {
    const start = vi.fn(async () => 'agent-klient-side');
    const port = createKlientSessionBtwPort({ btw: { start } });

    await expect(port.start()).resolves.toBe('agent-klient-side');
    expect(start).toHaveBeenCalledOnce();
  });
});
