/**
 * Scenario: runtime-neutral session identities are projected into session picker rows.
 * Responsibilities: preserve filtering and every picker display field, including metadata.
 * Wiring: the pure row projection is real and receives complete SessionIdentity fixtures.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/utils/session-picker-rows.test.ts
 */

import { describe, expect, it } from 'vitest';

import type { SessionIdentity } from '#/tui/runtime/session-control-port';
import { sessionRowsForPicker } from '#/tui/utils/session-picker-rows';

function identity(input: {
  readonly id: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): SessionIdentity {
  return {
    id: input.id,
    title: input.title,
    lastPrompt: input.lastPrompt,
    workDir: '/tmp/project',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    metadata: input.metadata,
  };
}

describe('sessionRowsForPicker', () => {
  it('omits the current session when the TUI session has no content', () => {
    const rows = sessionRowsForPicker(
      [
        identity({ id: 'ses_current', title: 'New Session' }),
        identity({ id: 'ses_previous', title: 'New Session' }),
      ],
      'ses_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_previous']);
  });

  it('keeps the current session when the TUI session has content', () => {
    const rows = sessionRowsForPicker(
      [
        identity({
          id: 'ses_current',
          title: 'Implement feature',
          lastPrompt: 'Implement feature',
        }),
      ],
      'ses_current',
      true,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_current']);
  });

  it('does not filter empty historical sessions', () => {
    const rows = sessionRowsForPicker(
      [
        identity({ id: 'ses_current', title: 'New Session' }),
        identity({ id: 'ses_previous_empty', title: 'New Session' }),
      ],
      'ses_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_previous_empty']);
  });

  it('maps neutral identity display fields and metadata into a picker row', () => {
    const rows = sessionRowsForPicker(
      [
        identity({
          id: 'ses_previous',
          title: 'Implement feature',
          lastPrompt: 'Please implement the feature',
          metadata: { branch: 'feature' },
        }),
      ],
      'ses_current',
      false,
    );

    expect(rows).toEqual([
      {
        id: 'ses_previous',
        title: 'Implement feature',
        last_prompt: 'Please implement the feature',
        work_dir: '/tmp/project',
        updated_at: 2,
        metadata: { branch: 'feature' },
      },
    ]);
  });
});
