<!-- apps/kimi-web/src/components/dialogs/BottomSheet.vue -->
<!-- Reusable mobile bottom sheet: a fading scrim + a panel that slides up from -->
<!-- the bottom (rounded top, grab handle). v-model controls open state; tapping -->
<!-- the scrim or the grab handle closes it, and the handle (or the panel's top -->
<!-- strip) drags to close — follow the finger 1:1, then close past the -->
<!-- distance/velocity threshold or spring back home. Restyled to the unified -->
<!-- v2 dialog look (tokened scrim, surface-raised panel, UI font). Esc yields -->
<!-- to any open design-system Dialog (dialogStack) and background scroll is -->
<!-- locked while open. -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch, type CSSProperties } from 'vue';
import { useI18n } from 'vue-i18n';
import { openDialogCount } from '../../composables/dialogStack';
import { shouldCloseSheetDrag } from '../../lib/interaction';

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

// Drag-to-close: a pointer that goes down on the grab handle (or the panel's
// top strip) drags the panel 1:1 with its transition disabled; releasing past
// the distance or velocity threshold closes the sheet, anything else springs
// back home. The scrollable body keeps native scrolling unless it is already
// at the top (pull-to-close).
const DRAG_ZONE_PX = 48;
const DRAG_CLICK_SLOP_PX = 5;

const panelRef = ref<HTMLElement | null>(null);
const dragging = ref(false);
const closing = ref(false);
const dragY = ref(0);

let activePointerId = -1;
let startClientY = 0;
let lastClientY = 0;
let lastMoveAt = 0;
let velocity = 0;
let moved = false;
let suppressClick = false;
let panelHeight = 0;

const panelStyle = computed<CSSProperties | undefined>(() =>
  dragY.value > 0 ? { '--sheet-drag-y': `${dragY.value}px` } : undefined,
);

// The scrim dims in proportion to the drag and eases back on release.
const scrimStyle = computed<CSSProperties | undefined>(() => {
  if (!dragging.value || panelHeight <= 0) return undefined;
  return { opacity: Math.max(0, 1 - dragY.value / panelHeight).toFixed(3) };
});

function onPanelPointerDown(e: PointerEvent): void {
  if (!props.modelValue || dragging.value || closing.value) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const panel = panelRef.value;
  if (!panel) return;
  const target = e.target instanceof Element ? e.target : null;
  const onGrab = !!target?.closest('.sheet-grab');
  const inDragZone = e.clientY - panel.getBoundingClientRect().top <= DRAG_ZONE_PX;
  if (!onGrab && !inDragZone) return;
  const body = target?.closest('.sheet-body');
  if (body instanceof HTMLElement && body.scrollTop > 0) return;

  activePointerId = e.pointerId;
  startClientY = e.clientY;
  lastClientY = e.clientY;
  lastMoveAt = e.timeStamp;
  velocity = 0;
  moved = false;
  suppressClick = false;
  panelHeight = panel.getBoundingClientRect().height;
  dragging.value = true;
  panel.setPointerCapture(e.pointerId);
}

function onPanelPointerMove(e: PointerEvent): void {
  if (!dragging.value || e.pointerId !== activePointerId) return;
  const dt = e.timeStamp - lastMoveAt;
  if (dt > 0) {
    velocity = 0.6 * ((e.clientY - lastClientY) / dt) + 0.4 * velocity;
  }
  lastClientY = e.clientY;
  lastMoveAt = e.timeStamp;
  if (Math.abs(e.clientY - startClientY) > DRAG_CLICK_SLOP_PX) moved = true;
  dragY.value = Math.max(0, e.clientY - startClientY);
}

function onPanelPointerUp(e: PointerEvent): void {
  if (!dragging.value || e.pointerId !== activePointerId) return;
  // A finger that rested before release is not a fling.
  if (e.timeStamp - lastMoveAt > 100) velocity = 0;
  endDrag();
}

function onPanelPointerCancel(e: PointerEvent): void {
  if (!dragging.value || e.pointerId !== activePointerId) return;
  endDrag(true);
}

function endDrag(cancelled = false): void {
  const dy = dragY.value;
  const shouldClose = shouldCloseSheetDrag(dy, velocity, cancelled);
  dragging.value = false;
  closing.value = shouldClose;
  dragY.value = 0;
  velocity = 0;
  if (moved) suppressClick = true;
  if (shouldClose) close();
}

// A drag that moved swallows the grab handle's follow-up click so releasing a
// spring-back (or a drag-close) doesn't immediately close the sheet again.
function onGrabClick(): void {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  close();
}

watch(
  () => props.modelValue,
  (open) => {
    if (typeof document === 'undefined') return;
    if (open) {
      // Every open starts settled, even if the previous close was a drag.
      dragging.value = false;
      closing.value = false;
      dragY.value = 0;
      velocity = 0;
      moved = false;
      suppressClick = false;
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
      <div class="sheet-scrim" :style="scrimStyle" @click="close" />
      <div
        ref="panelRef"
        class="sheet-panel"
        :class="{ 'sheet-panel--dragging': dragging, 'sheet-panel--closing': closing }"
        :style="panelStyle"
        role="dialog"
        :aria-label="title || t('mobile.sheetLabel')"
        @pointerdown="onPanelPointerDown"
        @pointermove="onPanelPointerMove"
        @pointerup="onPanelPointerUp"
        @pointercancel="onPanelPointerCancel"
      >
        <button
          type="button"
          class="sheet-grab"
          :aria-label="t('mobile.closeSheet')"
          @click="onGrabClick"
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
  /* Eases the drag dimming back to full when the pointer releases. */
  transition: opacity var(--duration-base) var(--ease-out);
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
  /* Springs the panel home when a drag is released under the close threshold
     (the enter/leave slide uses its own slow transition below). */
  transition: transform var(--duration-base) var(--ease-out);
}

/* Grab handle — a tap target to close and the primary drag-to-close handle.
   touch-action: none keeps touch pans from being stolen by scrolling. */
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
  touch-action: none;
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
  /* Part of the top drag zone; nothing here scrolls. */
  touch-action: none;
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

/* Drag-to-close. While tracking, --dragging disables every transition and
   follows the pointer through the inline --sheet-drag-y offset. Releasing
   under the threshold drops the class and the panel's base transform
   transition springs it home; releasing past it swaps to --closing, which
   slides the panel off-screen from wherever the drag ended while the root's
   leave fade runs (kept after the leave rules above so it wins the tie). */
.sheet-panel--dragging {
  transition: none;
  transform: translateY(var(--sheet-drag-y, 0px));
  user-select: none;
}
.sheet-panel--closing {
  transition: transform var(--duration-slow) var(--ease-out);
  transform: translateY(102%);
}

/* Reduced motion: drop the slide-up, keep the scrim/panel as a plain fade
   (the root opacity transition above still runs). The 1:1 drag follow stays —
   direct manipulation, not animation — but every settle becomes instant. */
@media (prefers-reduced-motion: reduce) {
  .sheet-enter-active .sheet-panel,
  .sheet-leave-active .sheet-panel {
    transition: none;
  }
  .sheet-enter-from .sheet-panel,
  .sheet-leave-to .sheet-panel {
    transform: none;
  }
  .sheet-panel,
  .sheet-scrim {
    transition: none;
  }
  .sheet-panel--closing {
    transition: none;
    transform: none;
  }
}
</style>
