/**
 * Scenario: AGENTS.md generation crosses the TUI session runtime boundary.
 * Responsibilities: legacy and Klient adapters preserve generation and
 * cancellation semantics. Each session facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-init-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionInitPort } from '#/tui/runtime/klient-session-init-adapter';

describe('Klient session init adapter', () => {
  it('calls session.init.generateAgentsMd when generation starts', async () => {
    const generateAgentsMd = vi.fn(async () => undefined);
    const port = createKlientSessionInitPort({
      init: {
        generateAgentsMd,
        cancel: vi.fn(async () => undefined),
      },
    });

    await port.generateAgentsMd();

    expect(generateAgentsMd).toHaveBeenCalledOnce();
  });

  it('calls session.init.cancel when cancel stops generation', async () => {
    const cancel = vi.fn(async () => undefined);
    const port = createKlientSessionInitPort({
      init: {
        generateAgentsMd: vi.fn(async () => undefined),
        cancel,
      },
    });

    await port.cancel();

    expect(cancel).toHaveBeenCalledOnce();
  });
});
