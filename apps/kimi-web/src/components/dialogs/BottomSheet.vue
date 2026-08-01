<!-- apps/kimi-web/src/components/dialogs/BottomSheet.vue -->
<!-- Reusable mobile bottom sheet: a fading scrim + a panel that slides up from -->
<!-- the bottom (rounded top, grab handle). v-model controls open state; tapping -->
<!-- the scrim or the grab handle closes it. Restyled to the unified v2 dialog -->
<!-- look (tokened scrim, surface-raised panel, UI font). Esc yields to any -->
<!-- open design-system Dialog (dialogStack) and background scroll is locked -->
<!-- while open. -->
<script setup lang="ts">
import { onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { openDialogCount } from '../../composables/dialogStack';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    /** Open state (use with v-model). */
    modelValue: boolean;
    /** Optional sheet title shown in the header strip. */
    title?: string;
  }>(),
  { title: '' },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  close: [];
}>();

function close(): void {
  emit('update:modelValue', false);
  emit('close');
}

// Close on Escape while open (desktop keyboard / test convenience). Any open
// design-system Dialog (e.g. a ConfirmDialog stacked above the sheet in the
// delete-workspace flow) owns Escape — bail out so one Esc doesn't close both.
function onKeydown(e: KeyboardEvent): void {
  if (openDialogCount.value > 0) return;
  if (e.key === 'Escape') close();
}

// Lock background scroll while the sheet is open; restore the previous inline
// value on close and on unmount.
let savedOverflow = '';
function setScrollLock(locked: boolean): void {
  if (locked) {
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  } else {
    document.documentElement.style.overflow = savedOverflow;
    savedOverflow = '';
  }
}

watch(
  () => props.modelValue,
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
  <Transition name="sheet">
    <div v-if="modelValue" class="sheet-root">
      <div class="sheet-scrim" @click="close" />
      <div class="sheet-panel" role="dialog" :aria-label="title || t('mobile.sheetLabel')">
        <button
          type="button"
          class="sheet-grab"
          :aria-label="t('mobile.closeSheet')"
          @click="close"
        />
        <div v-if="title" class="sheet-head">
          <span class="sheet-title">{{ title }}</span>
        </div>
        <div class="sheet-body">
          <slot />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.sheet-root {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.sheet-scrim {
  position: absolute;
  inset: 0;
  background: rgba(13, 17, 23, 0.45);
}

.sheet-panel {
  position: relative;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-bottom: none;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  box-shadow: var(--shadow-xl);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  min-height: 0;
  font-family: var(--font-ui);
  color: var(--color-text);
}

/* Grab handle — also a tap target to close. */
.sheet-grab {
  flex: none;
  align-self: center;
  width: 56px;
  height: 18px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  position: relative;
  margin-top: 4px;
}
.sheet-grab::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 7px;
  transform: translateX(-50%);
  width: 38px;
  height: 5px;
  border-radius: var(--radius-full);
  background: var(--color-line);
}

.sheet-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px 10px;
}
.sheet-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: max(16px, var(--safe-bottom));
}

/* Slide-up + fade transition for the whole sheet (scrim fades, panel slides). */
.sheet-enter-active,
.sheet-leave-active {
  transition: opacity var(--duration-slow) var(--ease-out);
}
.sheet-enter-active .sheet-panel,
.sheet-leave-active .sheet-panel {
  transition: transform var(--duration-slow) var(--ease-out);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from .sheet-panel,
.sheet-leave-to .sheet-panel {
  transform: translateY(102%);
}

/* Reduced motion: drop the slide-up, keep the scrim/panel as a plain fade
   (the root opacity transition above still runs). */
@media (prefers-reduced-motion: reduce) {
  .sheet-enter-active .sheet-panel,
  .sheet-leave-active .sheet-panel {
    transition: none;
  }
  .sheet-enter-from .sheet-panel,
  .sheet-leave-to .sheet-panel {
    transform: none;
  }
}
</style>
