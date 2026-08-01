<!-- apps/kimi-web/src/components/ResizeHandle.vue -->
<!-- A thin (~4px) drag bar. Axis x (default) resizes the panel to its LEFT
     (col-resize). Axis y resizes a BOTTOM panel (row-resize, reverse grows
     upward). Owns the size via useResizable and reports changes through
     v-model:width so the parent can drive its grid/flex sizing. Also
     keyboard-operable (separator role): arrows step ±4px (Shift ±16px),
     Home/End jump to the clamps, double-click restores defaultWidth. -->
<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useResizable } from '../composables/useResizable';

const props = withDefaults(
  defineProps<{
    storageKey: string;
    defaultWidth: number;
    min: number;
    max: number;
    reverse?: boolean;
    /** `x` = vertical bar / width (default); `y` = horizontal bar / height. */
    axis?: 'x' | 'y';
    ariaLabel?: string;
  }>(),
  {
    axis: 'x',
  },
);

const emit = defineEmits<{
  'update:width': [width: number];
  /** True while dragging — parents disable size transitions so the panel
      tracks the pointer without animation lag. */
  'update:dragging': [dragging: boolean];
}>();

const { t } = useI18n();

const { width, dragging, setWidth, onPointerDown } = useResizable({
  storageKey: props.storageKey,
  defaultWidth: props.defaultWidth,
  min: props.min,
  // Pass a getter so the cap stays reactive: a viewport-derived max can grow
  // after the handle mounts and the next drag will use the new limit.
  max: () => props.max,
  reverse: props.reverse,
  axis: props.axis,
});

// Surface the restored size immediately, then keep the parent in sync on drag.
emit('update:width', width.value);
watch(width, (w) => emit('update:width', w));
watch(dragging, (d) => emit('update:dragging', d));

// Keyboard operation for the separator role. Arrow keys mirror the drag math
// (including the `reverse` flip), so a key press moves the panel exactly where
// the equivalent drag would; Home/End jump to the clamps and double-click
// restores the default width. Everything funnels through setWidth (clamp +
// persist), so the watch above emits the same update:width events as a drag.
const KEY_STEP = 4;
const KEY_STEP_LARGE = 16;

function onKeydown(event: KeyboardEvent): void {
  let direction: number;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') direction = 1;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') direction = -1;
  else if (event.key === 'Home') {
    event.preventDefault();
    setWidth(props.min);
    return;
  } else if (event.key === 'End') {
    event.preventDefault();
    setWidth(props.max);
    return;
  } else {
    return;
  }
  event.preventDefault();
  const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  setWidth(width.value + (props.reverse ? -direction : direction) * step);
}

function onDblClick(): void {
  setWidth(props.defaultWidth);
}
</script>

<template>
  <div
    class="rh"
    :class="{ dragging, 'rh--y': axis === 'y' }"
    role="separator"
    tabindex="0"
    :aria-orientation="axis === 'y' ? 'horizontal' : 'vertical'"
    :aria-label="ariaLabel ?? t('layout.resizeHandleAria')"
    :aria-valuenow="width"
    :aria-valuemin="min"
    :aria-valuemax="max"
    @pointerdown="onPointerDown"
    @keydown="onKeydown"
    @dblclick="onDblClick"
  >
    <span class="rh-bar" aria-hidden="true"></span>
    <span class="rh-grip" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.rh {
  width: 4px;
  flex: none;
  cursor: col-resize;
  position: relative;
  align-self: stretch;
  background: transparent;
  touch-action: none;
  /* sits over the 1px column border so the whole 4px strip is grabbable */
  margin: 0 -2px;
  /* above pane-level sticky chrome (chat dock, headers at --z-sticky): its 2px
     overhang into the neighbour pane must stay visible and grabbable */
  z-index: var(--z-dropdown);
}
.rh--y {
  width: auto;
  height: 4px;
  cursor: row-resize;
  align-self: auto;
  justify-self: stretch;
  margin: -2px 0;
}
.rh:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
/* 2px core centered over the column border; thickens to the full 4px strip on
   hover / drag / keyboard focus (transform, so it stays cheap to animate). */
.rh-bar {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  background: transparent;
  transform: translateX(-50%);
  transition:
    background-color var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.rh:hover .rh-bar,
.rh.dragging .rh-bar,
.rh:focus-visible .rh-bar {
  background-color: var(--color-accent);
  transform: translateX(-50%) scaleX(2);
}
.rh--y .rh-bar {
  top: 50%;
  bottom: auto;
  left: 0;
  right: 0;
  width: auto;
  height: 2px;
  transform: translateY(-50%);
}
.rh--y:hover .rh-bar,
.rh--y.dragging .rh-bar,
.rh--y:focus-visible .rh-bar {
  transform: translateY(-50%) scaleY(2);
}
/* Resting affordance: three faint dots mark the grabbable strip so the
   invisible handle is discoverable; they fade out as the accent core
   thickens in on hover / drag / focus. */
.rh-grip {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: var(--color-text-faint);
  box-shadow:
    0 -5px 0 var(--color-text-faint),
    0 5px 0 var(--color-text-faint);
  transform: translate(-50%, -50%);
  opacity: 0.7;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.rh:hover .rh-grip,
.rh.dragging .rh-grip,
.rh:focus-visible .rh-grip {
  opacity: 0;
}
.rh--y .rh-grip {
  box-shadow:
    -5px 0 0 var(--color-text-faint),
    5px 0 0 var(--color-text-faint);
}
</style>
