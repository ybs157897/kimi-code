// apps/kimi-web/src/composables/useMenuKeyboard.ts
// Pure decision helpers behind <Menu>'s keyboard support (Menu.vue). The
// component keeps the DOM side effects — querying the enabled item buttons,
// moving focus, clicking the active item, handing focus back to the opener;
// what lives here is which item index a navigation key moves to (↑/↓ with
// wrap, Home/End) and first-letter typeahead matching.

/** Navigation keys <Menu> resolves to a target item index. */
export type MenuNavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * Item index a navigation key should move focus to, or null for an empty
 * menu. ↑/↓ wrap at the ends; when nothing inside the menu has focus yet
 * (from < 0), ArrowDown starts at the first item and ArrowUp at the last.
 * Home/End jump to the first/last item regardless of the current focus.
 */
export function menuNavIndex(count: number, from: number, key: MenuNavKey): number | null {
  if (count === 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const delta = key === 'ArrowDown' ? 1 : -1;
  return from < 0 ? (delta > 0 ? 0 : count - 1) : (from + delta + count) % count;
}

/**
 * First-letter typeahead: index of the next item whose label starts with the
 * typed character (case-insensitive, wrapping past the end), or null when the
 * menu is empty or nothing matches. The search starts right after `from` (the
 * focused item index, or -1 when nothing has focus) and runs a full lap, so
 * repeating the same character cycles through every match.
 */
export function menuTypeaheadIndex(labels: string[], from: number, char: string): number | null {
  const count = labels.length;
  if (count === 0) return null;
  const needle = char.toLowerCase();
  for (let step = 1; step <= count; step += 1) {
    const index = (Math.max(from, 0) + step) % count;
    const label = labels[index];
    if (label !== undefined && label.trimStart().toLowerCase().startsWith(needle)) {
      return index;
    }
  }
  return null;
}
