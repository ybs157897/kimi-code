<!-- apps/kimi-web/src/components/ui/Sheet.vue -->
<!-- Design-system §03 Sheet / BottomSheet: mobile bottom panel (≤640px dialogs
     anchor here). Top radius xl + drag handle + xl shadow. Enters and leaves
     via a <Transition> (scrim fade + panel slide-up, the same motion as
     dialogs/BottomSheet and the kimi-sheet-up keyframe); Esc closes it —
     yielding to any open design-system Dialog (dialogStack) — and background
     scroll is locked while open. -->
<script setup lang="ts">
import { onUnmounted, watch } from 'vue';
import { openDialogCount } from '../../composables/dialogStack';
import IconButton from './IconButton.vue';
import Icon from './Icon.vue';

const props = defineProps<{ open: boolean; title?: string }>();

const emit = defineEmits<{ 'update:open': [value: boolean]; close: [] }>();

function close() {
  emit('update:open', false);
  emit('close');
}

// Close on Escape while open (desktop keyboard / test convenience). Any open
// design-system Dialog (dialogStack) owns Escape — bail out so one Esc doesn't
// close both.
function onKeydown(e: KeyboardEvent) {
  if (openDialogCount.value > 0) return;
  if (e.key === 'Escape') close();
}

// Lock background scroll while the sheet is open; restore the previous inline
// value on close and on unmount.
let savedOverflow = '';
function setScrollLock(locked: boolean) {
  if (locked) {
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  } else {
    document.documentElement.style.overflow = savedOverflow;
    savedOverflow = '';
  }
}

watch(
  () => props.open,
  (open) => {
    if (typeof document === 'undefined') return;
    if (open) {
      document.addEventListener('keydown', onKeydown);
      setScrollLock(true);
    } else {
      document.removeEventListener('keydown', onKeydown);
      setScrollLock(false);
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  if (typeof document === 'undefined') return;
  document.removeEventListener('keydown', onKeydown);
  setScrollLock(false);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-sheet">
      <div v-if="open" class="ui-sheet__scrim" @mousedown.self="close">
        <div class="ui-sheet" role="dialog" aria-modal="true">
          <div class="ui-sheet__handle" aria-hidden="true" />
          <div v-if="title" class="ui-sheet__head">
            <span class="ui-sheet__title">{{ title }}</span>
            <IconButton size="sm" label="Close" @click="close">
              <Icon name="close" size="md" />
            </IconButton>
          </div>
          <div class="ui-sheet__body"><slot /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-sheet__scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(13, 17, 23, 0.45);
}
.ui-sheet {
  width: 100%;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}
.ui-sheet__handle {
  width: 36px;
  height: 4px;
  margin: var(--space-2) auto 0;
  border-radius: var(--radius-full);
  background: var(--color-line-strong);
  flex: none;
}
.ui-sheet__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
}
.ui-sheet__title { flex: 1; font-size: var(--text-lg); font-weight: var(--weight-medium); color: var(--color-text); }
.ui-sheet__body { padding: var(--space-2) var(--space-4) var(--space-5); overflow: auto; color: var(--color-text); }

/* Slide-up + fade enter/leave, mirroring dialogs/BottomSheet: the scrim fades
   while the panel slides up from below the viewport (the kimi-sheet-up motion).
   Reduced motion is covered by the global kill-switch in style.css. */
.ui-sheet-enter-active,
.ui-sheet-leave-active {
  transition: opacity var(--duration-slow) var(--ease-out);
}
.ui-sheet-enter-active .ui-sheet,
.ui-sheet-leave-active .ui-sheet {
  transition: transform var(--duration-slow) var(--ease-out);
}
.ui-sheet-enter-from,
.ui-sheet-leave-to {
  opacity: 0;
}
.ui-sheet-enter-from .ui-sheet,
.ui-sheet-leave-to .ui-sheet {
  transform: translateY(102%);
}
</style>
