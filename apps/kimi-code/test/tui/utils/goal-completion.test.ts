/**
 * Scenario: completed goals produce deterministic transcript copy from the neutral goal DTO.
 * Responsibilities: preserve reason, singularization, elapsed time, and token formatting.
 * Wiring: the pure formatter is real and receives complete AgentGoal fixtures.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/utils/goal-completion.test.ts
 */

import { describe, expect, it } from 'vitest';

import type { AgentGoal } from '#/tui/runtime/session-control-port';
import { buildGoalCompletionMessage } from '#/tui/utils/goal-completion';

function snapshot(overrides: Partial<AgentGoal> = {}): AgentGoal {
  return {
    goalId: 'g1',
    objective: 'work',
    status: 'complete',
    turnsUsed: 3,
    tokensUsed: 12_500,
    wallClockMs: 260_000,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
    terminalReason: 'all tests pass',
    ...overrides,
  };
}

describe('buildGoalCompletionMessage', () => {
  it('includes the reason, exact turns, tokens, and time', () => {
    const text = buildGoalCompletionMessage(snapshot());
    expect(text).toContain('Goal complete — all tests pass.');
    expect(text).toContain('3 turns');
    expect(text).toContain('12.2k tokens');
    expect(text).toContain('4m20s');
  });

  it('omits the dash when there is no reason and singularizes one turn', () => {
    const text = buildGoalCompletionMessage(
      snapshot({ terminalReason: undefined, turnsUsed: 1, tokensUsed: 800, wallClockMs: 5000 }),
    );
    expect(text).toContain('Goal complete.');
    expect(text).not.toContain('—');
    expect(text).toContain('1 turn ');
    expect(text).toContain('800 tokens');
    expect(text).toContain('5s');
  });
});
