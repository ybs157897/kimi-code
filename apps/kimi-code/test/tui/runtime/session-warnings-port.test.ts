/**
 * Scenario: startup warnings cross the active-session TUI runtime boundary.
 * Responsibilities: both adapters return copied neutral warning views, and
 * Klient warnings without severity use the warning default. Each runtime
 * session facade is the single stubbed boundary.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/runtime/session-warnings-port.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { createKlientSessionWarningsPort } from '#/tui/runtime/klient-session-warnings-adapter';

describe('session warnings runtime port (adapter contract)', () => {
  it('list normalizes copied Klient warnings without severity to warning', async () => {
    const warning = {
      code: 'secondary-model-invalid',
      message: 'Check the secondary model configuration.',
    };
    const warnings = [warning];
    const session = {
      warnings: {
        list: vi.fn(async () => warnings),
      },
    };

    const result = await createKlientSessionWarningsPort(session).list();

    expect(result).toEqual([
      {
        code: 'secondary-model-invalid',
        message: 'Check the secondary model configuration.',
        severity: 'warning',
      },
    ]);
    expect(result).not.toBe(warnings);
    expect(result[0]).not.toBe(warning);
  });
});
