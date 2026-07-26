<!-- apps/kimi-web/src/components/ResizeHandle.vue -->
<!-- A thin (~4px) drag bar. Axis x (default) resizes the panel to its LEFT
     (col-resize). Axis y resizes a BOTTOM panel (row-resize, reverse grows
     upward). Owns the size via useResizable and reports changes through
     v-model:width so the parent can drive its grid/flex sizing. -->
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

const { width, dragging, onPointerDown } = useResizable({
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
</script>

<template>
  <div
    class="rh"
    :class="{ dragging, 'rh--y': axis === 'y' }"
    role="separator"
    :aria-orientation="axis === 'y' ? 'horizontal' : 'vertical'"
    :aria-label="ariaLabel ?? t('layout.resizeHandleAria')"
    @pointerdown="onPointerDown"
  >
    <span class="rh-bar" aria-hidden="true"></span>
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
.rh-bar {
  position: absolute;
  inset: 0;
  background: transparent;
  transition: background 0.12s;
}
.rh:hover .rh-bar,
.rh.dragging .rh-bar {
  background: var(--color-accent);
}
</style>
