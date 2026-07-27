/**
 * Scenario: render runtime-neutral goal and swarm transcript markers.
 * Responsibilities: lifecycle copy, actor attribution, silent completion, expansion, and width.
 * Wiring: real presentation components with no external collaborators.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/components/messages/goal-markers.test.ts
 */
import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { SwarmModeMarkerComponent } from '#/tui/components/messages/swarm-markers';
import {
  buildGoalMarker,
  type GoalMarkerChange,
  GoalMarkerComponent,
} from '#/tui/components/messages/goal-markers';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(lines: string[]): string {
  return lines.join('\n').replaceAll(ANSI_SGR, '');
}

describe('buildGoalMarker', () => {
  it('renders a paused lifecycle change as a paused marker', () => {
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused' } satisfies GoalMarkerChange,
      false,
    );
    expect(strip(marker!.render(80))).toBe('\n● Goal paused');
  });

  it('renders an active lifecycle change as a resumed marker', () => {
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'active' } satisfies GoalMarkerChange,
      false,
    );
    expect(strip(marker!.render(80))).toBe('\n● Goal resumed');
  });

  it('renders a blocked lifecycle change as a blocked marker', () => {
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'blocked' } satisfies GoalMarkerChange,
      false,
    );
    expect(strip(marker!.render(80))).toBe('  ◦ Goal blocked');
  });

  it('attributes an interruption pause to the user from its runtime reason', () => {
    const marker = buildGoalMarker(
      {
        kind: 'lifecycle',
        status: 'paused',
        reason: 'Paused after interruption',
      } satisfies GoalMarkerChange,
      false,
      'runtime',
    );

    expect(strip(marker!.render(80))).toBe("\n● Goal paused due to user's interruption");
  });

  it('attributes a user resume marker to the user', () => {
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'active' } satisfies GoalMarkerChange,
      false,
      'user',
    );

    expect(strip(marker!.render(80))).toBe('\n● Goal resumed by the user.');
  });

  it('attributes a user pause marker to the user', () => {
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused' } satisfies GoalMarkerChange,
      false,
      'user',
    );

    expect(strip(marker!.render(80))).toBe('\n● Goal paused by the user.');
  });

  it('does not repeat paused for runtime pause reasons', () => {
    const marker = buildGoalMarker(
      {
        kind: 'lifecycle',
        status: 'paused',
        reason: 'Paused after runtime error: socket hang up',
      } satisfies GoalMarkerChange,
      false,
      'runtime',
    );

    expect(strip(marker!.render(80))).toBe('\n● Goal paused after runtime error: socket hang up');
  });

  it('keeps long provider pause markers within the terminal width', () => {
    const reason =
      'Paused after provider API error: 400 {"error":{"message":"request id: 456043b9-6491-11f1-9425-2221bb1af97c, \\"thinking.enabled\\" is not supported for this model. Use \\"thinking.adaptive\\" and \\"output_config.effort\\" to control thinking behavior.","type":"invalid_request_error"}}';
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused', reason } satisfies GoalMarkerChange,
      false,
      'runtime',
    );

    const width = 80;
    expect(strip(marker!.render(width))).toContain('Goal paused after provider API error');
    for (const line of marker!.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('attributes a model pause marker to the agent', () => {
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'paused' } satisfies GoalMarkerChange,
      false,
      'model',
    );

    expect(strip(marker!.render(80))).toBe('\n● Goal paused by the agent.');
  });

  it('attributes a model resume marker to the agent', () => {
    const marker = buildGoalMarker(
      { kind: 'lifecycle', status: 'active' } satisfies GoalMarkerChange,
      false,
      'model',
    );

    expect(strip(marker!.render(80))).toBe('\n● Goal resumed by the agent.');
  });

  it('returns null when the change is a completion', () => {
    expect(
      buildGoalMarker(
        {
          kind: 'completion',
          status: 'complete',
          reason: 'Objective satisfied',
        } satisfies GoalMarkerChange,
        false,
      ),
    ).toBeNull();
  });
});

describe('GoalMarkerComponent', () => {
  it('hides the reason until expanded, with a ctrl+o hint', () => {
    const marker = new GoalMarkerComponent('Goal: no progress', 'still spinning', 'warning');
    const collapsed = strip(marker.render(80));
    expect(collapsed).toContain('Goal: no progress');
    expect(collapsed).toContain('(ctrl+o)');
    expect(collapsed).not.toContain('still spinning');

    marker.setExpanded(true);
    const expanded = strip(marker.render(80));
    expect(expanded).toContain('still spinning');
    expect(expanded).not.toContain('(ctrl+o)');
  });

  it('renders a single line when there is no reason', () => {
    const marker = new GoalMarkerComponent('Goal paused', undefined, 'textDim');
    expect(marker.render(80)).toHaveLength(1);
    expect(strip(marker.render(80))).not.toContain('(ctrl+o)');
  });
});

describe('SwarmModeMarkerComponent', () => {
  it('keeps marker lines within very narrow widths', () => {
    const marker = new SwarmModeMarkerComponent('active');

    for (const width of [1, 2, 10, 39]) {
      for (const line of marker.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
