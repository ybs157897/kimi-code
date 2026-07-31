/**
 * Loading tip resolution: map the effective activity-pane mode to the kind
 * of loading tip shown while the session is busy.
 */

import type { ActivityPaneMode } from '#/tui/components/panes/activity-pane';

export type EffectiveActivityPaneMode = ActivityPaneMode | 'idle' | 'session';
export type LoadingTipKind = 'moon' | 'composing';

export function loadingTipKind(mode: EffectiveActivityPaneMode): LoadingTipKind | undefined {
  if (mode === 'waiting' || mode === 'tool') return 'moon';
  if (mode === 'composing') return 'composing';
  return undefined;
}
