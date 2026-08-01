// apps/kimi-web/src/composables/useRovingFocus.ts
// Roving-focus index math shared by the design-system tab-like controls
// (Tabs.vue, SegmentedControl.vue). Pure functions only — no DOM, no refs —
// so the navigation decision is unit-testable in isolation. The controls keep
// owning focus/emit; they only ask here which index a key should move to.
//
// Behavior is clamp, not wrap: at the first item, `prev` stays put; at the
// last item, `next` stays put (WAI-ARIA tabs pattern, matching the
// SearchSessionsDialog list navigation the components were modeled on).

export type RovingFocusIntent = 'prev' | 'next' | 'home' | 'end';

// Maps a keyboard key to a navigation intent, or null when the key is not a
// roving-focus key (the caller then leaves the event untouched).
export function rovingFocusIntent(key: string): RovingFocusIntent | null {
  if (key === 'ArrowLeft' || key === 'ArrowUp') return 'prev';
  if (key === 'ArrowRight' || key === 'ArrowDown') return 'next';
  if (key === 'Home') return 'home';
  if (key === 'End') return 'end';
  return null;
}

// Given the current index, the item count, and a navigation intent, returns
// the index to move to, clamped to [0, count - 1]. Returns the input index
// unchanged when the move would not change position (e.g. `prev` at 0).
export function rovingFocusIndex(index: number, count: number, intent: RovingFocusIntent): number {
  switch (intent) {
    case 'prev':
      return Math.max(0, index - 1);
    case 'next':
      return Math.min(count - 1, index + 1);
    case 'home':
      return 0;
    case 'end':
      return count - 1;
  }
}
