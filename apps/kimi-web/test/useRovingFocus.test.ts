// apps/kimi-web/test/useRovingFocus.test.ts
// Logic tests for the shared roving-focus index math used by Tabs.vue and
// SegmentedControl.vue: key → intent mapping, and the clamp-or-stay index
// computation (bounds, first/last, count=0/1 edge cases).
import { describe, expect, it } from 'vitest';
import { rovingFocusIndex, rovingFocusIntent } from '../src/composables/useRovingFocus';

describe('rovingFocusIntent', () => {
  it('maps the arrow keys to prev/next', () => {
    expect(rovingFocusIntent('ArrowLeft')).toBe('prev');
    expect(rovingFocusIntent('ArrowUp')).toBe('prev');
    expect(rovingFocusIntent('ArrowRight')).toBe('next');
    expect(rovingFocusIntent('ArrowDown')).toBe('next');
  });

  it('maps Home/End to home/end', () => {
    expect(rovingFocusIntent('Home')).toBe('home');
    expect(rovingFocusIntent('End')).toBe('end');
  });

  it('returns null for keys the controls do not handle', () => {
    expect(rovingFocusIntent('Enter')).toBeNull();
    expect(rovingFocusIntent(' ')).toBeNull();
    expect(rovingFocusIntent('Tab')).toBeNull();
    expect(rovingFocusIntent('a')).toBeNull();
  });
});

describe('rovingFocusIndex — clamp (no wrap)', () => {
  it('moves one step within bounds', () => {
    expect(rovingFocusIndex(1, 4, 'prev')).toBe(0);
    expect(rovingFocusIndex(1, 4, 'next')).toBe(2);
    expect(rovingFocusIndex(2, 4, 'prev')).toBe(1);
    expect(rovingFocusIndex(2, 4, 'next')).toBe(3);
  });

  it('stays put at the first item instead of wrapping to the last', () => {
    expect(rovingFocusIndex(0, 4, 'prev')).toBe(0);
  });

  it('stays put at the last item instead of wrapping to the first', () => {
    expect(rovingFocusIndex(3, 4, 'next')).toBe(3);
  });
});

describe('rovingFocusIndex — home/end', () => {
  it('jumps to the first item on home', () => {
    expect(rovingFocusIndex(3, 4, 'home')).toBe(0);
    expect(rovingFocusIndex(0, 4, 'home')).toBe(0);
  });

  it('jumps to the last item on end', () => {
    expect(rovingFocusIndex(0, 4, 'end')).toBe(3);
    expect(rovingFocusIndex(3, 4, 'end')).toBe(3);
  });
});

describe('rovingFocusIndex — edge counts', () => {
  it('count=1: every intent stays on the only item', () => {
    expect(rovingFocusIndex(0, 1, 'prev')).toBe(0);
    expect(rovingFocusIndex(0, 1, 'next')).toBe(0);
    expect(rovingFocusIndex(0, 1, 'home')).toBe(0);
    expect(rovingFocusIndex(0, 1, 'end')).toBe(0);
  });

  it('count=0: clamped intents stay at 0, unclamped fall to -1', () => {
    // No items exist; the controls never fire in this state (no buttons to
    // keydown on), but the pure math is well-defined: prev/home clamp to 0,
    // next/end fall to count - 1 = -1, which the caller's `if (!opt) return`
    // guard discards.
    expect(rovingFocusIndex(0, 0, 'prev')).toBe(0);
    expect(rovingFocusIndex(0, 0, 'home')).toBe(0);
    expect(rovingFocusIndex(0, 0, 'next')).toBe(-1);
    expect(rovingFocusIndex(0, 0, 'end')).toBe(-1);
  });
});
