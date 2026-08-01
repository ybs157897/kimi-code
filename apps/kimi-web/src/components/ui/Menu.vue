<!-- apps/kimi-web/src/components/ui/Menu.vue -->
<!-- Design-system §03 Menu: raised dropdown panel. Positioning is left to the
     consumer; this provides the surface + item layout, the open/close
     transition (fade + scale(0.98) + a small drift from the anchor corner),
     and menu keyboard support: roving tabindex over the MenuItem children with
     ↑/↓ (wrap) / Home / End, ↵/Space to activate, Esc to close (focus returns
     to the trigger), and first-letter typeahead. -->
<script setup lang="ts">
import { nextTick, provide, ref, shallowRef, watch } from 'vue';
import { menuContextKey, type MenuOrigin } from './menu-context';

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  /** Visibility flag. Consumers keep <Menu> mounted and toggle this instead
   *  of v-if, so the <Transition> can animate the close too (a parent v-if
   *  unmounts the surface before the leave transition could run). Defaults to
   *  true so a plainly mounted <Menu> shows immediately. */
  open?: boolean;
  /** Corner that meets the trigger — anchors the open/close transform-origin
   *  and the direction of the drift. */
  origin?: MenuOrigin;
}>(), { open: true, origin: 'top-right' });

const emit = defineEmits<{
  /** Esc was pressed while the menu had focus — the consumer hides the menu. */
  close: [];
}>();

// Expose the panel element so call sites can anchor / outside-click against the
// menu surface (positioning is intentionally left to the consumer).
const el = ref<HTMLElement>();
defineExpose({ el });

// Roving tabindex: exactly one item button is the Tab target (tabindex 0) and
// holds real DOM focus while the menu is open; MenuItem reads the marker
// through this injection to bind its own tabindex.
const tabTarget = shallowRef<HTMLElement | null>(null);
provide(menuContextKey, { tabTarget });

/** Enabled item buttons in DOM order — separators and plain slot content have
 *  no role="menuitem" and are skipped; disabled items can't take focus. */
function enabledItems(): HTMLElement[] {
  return Array.from(
    el.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [],
  );
}

function focusItem(item: HTMLElement): void {
  tabTarget.value = item;
  item.focus({ preventScroll: true });
}

// Element focused when the menu opened (the trigger) — Esc hands focus back.
let opener: HTMLElement | null = null;

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // v-show restores the surface this tick; land focus once it's rendered —
      // on the checked item when there is one, otherwise the first.
      await nextTick();
      if (!props.open) return;
      const items = enabledItems();
      const target = items.find((item) => item.classList.contains('is-active')) ?? items[0];
      if (target) focusItem(target);
    } else {
      tabTarget.value = null;
    }
  },
  { immediate: true },
);

/** Arrow navigation with wrap; when nothing inside the menu has focus yet,
 *  ArrowDown starts at the first item and ArrowUp at the last. */
function moveFocus(delta: 1 | -1): void {
  const items = enabledItems();
  if (items.length === 0) return;
  const active = document.activeElement;
  const from = active instanceof HTMLElement ? items.indexOf(active) : -1;
  const index =
    from < 0 ? (delta > 0 ? 0 : items.length - 1) : (from + delta + items.length) % items.length;
  const next = items[index];
  if (next) focusItem(next);
}

/** First-letter typeahead: focus the next item whose label starts with the
 *  typed character (case-insensitive, wrapping past the end). */
function typeahead(char: string): void {
  const items = enabledItems();
  if (items.length === 0) return;
  const needle = char.toLowerCase();
  const active = document.activeElement;
  const from = active instanceof HTMLElement ? items.indexOf(active) : -1;
  for (let step = 1; step <= items.length; step += 1) {
    const candidate = items[(Math.max(from, 0) + step) % items.length];
    if (candidate && (candidate.textContent ?? '').trimStart().toLowerCase().startsWith(needle)) {
      focusItem(candidate);
      return;
    }
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveFocus(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveFocus(-1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    const first = enabledItems()[0];
    if (first) focusItem(first);
  } else if (event.key === 'End') {
    event.preventDefault();
    const last = enabledItems().at(-1);
    if (last) focusItem(last);
  } else if (event.key === 'Enter' || event.key === ' ') {
    const items = enabledItems();
    const active = document.activeElement;
    const target =
      active instanceof HTMLElement && items.includes(active) ? active : tabTarget.value;
    if (target !== null && items.includes(target)) {
      // preventDefault so the native button activation doesn't fire on top of
      // the explicit click.
      event.preventDefault();
      target.click();
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    // Keep the dismissal local: a menu nested in a dialog must not also close
    // the dialog behind it.
    event.stopPropagation();
    emit('close');
    opener?.focus({ preventScroll: true });
    opener = null;
  } else if (event.key.length === 1) {
    typeahead(event.key);
  }
}
</script>

<template>
  <Transition name="ui-menu" appear>
    <div
      v-show="open"
      ref="el"
      class="ui-menu"
      :class="`ui-menu--${origin}`"
      role="menu"
      v-bind="$attrs"
      @keydown="onKeydown"
    >
      <slot />
    </div>
  </Transition>
</template>

<style scoped>
.ui-menu {
  min-width: 180px;
  padding: var(--space-1);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
}

/* Open/close motion: fade + scale(0.98) + a 3px drift toward the trigger,
   anchored on the corner that meets it (--duration-fast, --ease-out). The
   origin modifier aims the drift at the anchor: up while the menu hangs
   below the trigger, down after a viewport flip put it above. */
.ui-menu--top-left { transform-origin: top left; --ui-menu-ty: -3px; }
.ui-menu--top-right { transform-origin: top right; --ui-menu-ty: -3px; }
.ui-menu--bottom-left { transform-origin: bottom left; --ui-menu-ty: 3px; }
.ui-menu--bottom-right { transform-origin: bottom right; --ui-menu-ty: 3px; }

.ui-menu-enter-active,
.ui-menu-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.ui-menu-enter-from,
.ui-menu-leave-to {
  opacity: 0;
  transform: translateY(var(--ui-menu-ty, -3px)) scale(0.98);
}
</style>
