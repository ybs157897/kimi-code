// apps/kimi-web/test/useMenuKeyboard.test.ts
// Logic tests for the pure keyboard-navigation decisions extracted from
// Menu.vue: ↑/↓ navigation with wrap, Home/End, and first-letter typeahead
// matching (next match, wrap, no match, case-insensitivity).
import { describe, expect, it } from 'vitest';
import { menuNavIndex, menuTypeaheadIndex } from '../src/composables/useMenuKeyboard';

describe('menuNavIndex', () => {
  it('returns null for an empty menu', () => {
    expect(menuNavIndex(0, -1, 'ArrowDown')).toBeNull();
    expect(menuNavIndex(0, -1, 'ArrowUp')).toBeNull();
    expect(menuNavIndex(0, -1, 'Home')).toBeNull();
    expect(menuNavIndex(0, -1, 'End')).toBeNull();
  });

  it('moves down and wraps past the last item', () => {
    expect(menuNavIndex(3, 0, 'ArrowDown')).toBe(1);
    expect(menuNavIndex(3, 1, 'ArrowDown')).toBe(2);
    expect(menuNavIndex(3, 2, 'ArrowDown')).toBe(0);
  });

  it('moves up and wraps past the first item', () => {
    expect(menuNavIndex(3, 2, 'ArrowUp')).toBe(1);
    expect(menuNavIndex(3, 1, 'ArrowUp')).toBe(0);
    expect(menuNavIndex(3, 0, 'ArrowUp')).toBe(2);
  });

  it('stays put on a single-item menu', () => {
    expect(menuNavIndex(1, 0, 'ArrowDown')).toBe(0);
    expect(menuNavIndex(1, 0, 'ArrowUp')).toBe(0);
  });

  it('starts at the first/last item when nothing has focus yet', () => {
    expect(menuNavIndex(3, -1, 'ArrowDown')).toBe(0);
    expect(menuNavIndex(3, -1, 'ArrowUp')).toBe(2);
  });

  it('Home/End jump to the first/last item regardless of focus', () => {
    expect(menuNavIndex(4, 2, 'Home')).toBe(0);
    expect(menuNavIndex(4, 2, 'End')).toBe(3);
    expect(menuNavIndex(1, -1, 'Home')).toBe(0);
    expect(menuNavIndex(1, -1, 'End')).toBe(0);
  });
});

describe('menuTypeaheadIndex', () => {
  const labels = ['Apple', 'Banana', 'Cherry', 'apricot'];

  it('returns null for an empty menu', () => {
    expect(menuTypeaheadIndex([], -1, 'a')).toBeNull();
  });

  it('matches the next item whose label starts with the character', () => {
    expect(menuTypeaheadIndex(labels, -1, 'b')).toBe(1);
    expect(menuTypeaheadIndex(labels, 1, 'c')).toBe(2);
  });

  it('searches after the focused item and wraps past the end', () => {
    // From Banana (1) the candidates are Cherry, apricot, … — 'a' lands on
    // apricot (3), not Apple.
    expect(menuTypeaheadIndex(labels, 1, 'a')).toBe(3);
    // From apricot (3) the search wraps back to Apple (0).
    expect(menuTypeaheadIndex(labels, 3, 'a')).toBe(0);
  });

  it('can land back on the focused item after a full lap', () => {
    // From Apple (0), 'a' passes Banana/Cherry/apricot-first… apricot (3)
    // matches first; from Banana (1) with 'b' the only match is Banana itself
    // once the search wraps all the way around.
    expect(menuTypeaheadIndex(['Apple', 'Banana'], 1, 'b')).toBe(1);
  });

  it('is case-insensitive on both the label and the typed character', () => {
    expect(menuTypeaheadIndex(labels, 1, 'C')).toBe(2); // 'C' matches 'Cherry'
    expect(menuTypeaheadIndex(labels, 3, 'A')).toBe(0); // 'A' matches 'Apple'
    expect(menuTypeaheadIndex(['Über', 'other'], -1, 'ü')).toBe(0);
  });

  it('returns null when no label matches', () => {
    expect(menuTypeaheadIndex(labels, -1, 'z')).toBeNull();
    expect(menuTypeaheadIndex(labels, 2, 'z')).toBeNull();
  });

  it('ignores leading whitespace in labels', () => {
    expect(menuTypeaheadIndex(['  Padded', 'Other'], -1, 'p')).toBe(0);
  });

  it('repeating the character cycles through every match', () => {
    // 'a' matches apricot (3) and Apple (0); with nothing focused the search
    // starts at index 1, so apricot comes first, then it cycles 3 → 0 → 3.
    const first = menuTypeaheadIndex(labels, -1, 'a');
    expect(first).toBe(3);
    const second = menuTypeaheadIndex(labels, first ?? -1, 'a');
    expect(second).toBe(0);
    expect(menuTypeaheadIndex(labels, second ?? -1, 'a')).toBe(3);
  });
});
