<!-- apps/kimi-web/src/components/ui/SegmentedControl.vue -->
<!-- Design-system §03 SegmentedControl: 2-4 mutually exclusive options. The
     raised pill is a separate element that slides between segments; ←/→ (and
     ↑/↓) + Home/End move and activate segments via roving tabindex. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
  size?: 'sm' | 'md';
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const itemRefs = ref<HTMLButtonElement[]>([]);

const activeIndex = computed(() => props.options.findIndex((o) => o.value === props.modelValue));

// Sliding pill: measured off the active segment (offsetLeft/offsetWidth are
// relative to .ui-seg, the indicator's offsetParent). It is only rendered
// once the first measurement exists, so it can never animate on mount.
const indicator = ref<{ x: number; width: number } | null>(null);

function measure(): void {
  const el = activeIndex.value >= 0 ? itemRefs.value[activeIndex.value] : undefined;
  if (!el) {
    // Active value not in options: collapse the pill in place.
    if (indicator.value) indicator.value = { ...indicator.value, width: 0 };
    return;
  }
  indicator.value = { x: el.offsetLeft, width: el.offsetWidth };
}

// Roving tabindex: only the active segment is tabbable (first one as a
// fallback when the value is not in options).
function tabIndexFor(index: number): number {
  return index === (activeIndex.value === -1 ? 0 : activeIndex.value) ? 0 : -1;
}

// Automatic activation (WAI-ARIA tabs pattern): arrows move focus and select
// in one step, clamped like the SearchSessionsDialog list navigation.
function onKeydown(e: KeyboardEvent, index: number): void {
  let next: number;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, index - 1);
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(props.options.length - 1, index + 1);
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = props.options.length - 1;
  else return;
  e.preventDefault();
  if (next === index) return;
  const opt = props.options[next];
  if (!opt) return;
  emit('update:modelValue', opt.value);
  itemRefs.value[next]?.focus();
}

onMounted(() => {
  measure();
  window.addEventListener('resize', measure);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure);
});

// flush: 'post' so the measurement runs after the DOM reflects the new
// active segment / option list.
watch([() => props.modelValue, () => props.options], measure, { flush: 'post' });
</script>

<template>
  <div class="ui-seg" :class="`ui-seg--${size ?? 'md'}`" role="tablist">
    <span
      v-if="indicator"
      class="ui-seg__indicator"
      aria-hidden="true"
      :style="{ width: `${indicator.width}px`, transform: `translateX(${indicator.x}px)` }"
    />
    <button
      v-for="(opt, i) in options"
      :key="opt.value"
      ref="itemRefs"
      class="ui-seg__item"
      :class="{ 'is-on': opt.value === modelValue }"
      type="button"
      role="tab"
      :aria-selected="opt.value === modelValue"
      :tabindex="tabIndexFor(i)"
      @click="emit('update:modelValue', opt.value)"
      @keydown="onKeydown($event, i)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.ui-seg {
  position: relative;
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
}
/* The pill replaced the active segment's own background/box-shadow; it sits
   inside the control's 2px padding, exactly where that segment painted. */
.ui-seg__indicator {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 0;
  background: var(--color-surface-raised);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-xs);
  pointer-events: none;
  transition: transform var(--duration-base) var(--ease-out),
    width var(--duration-base) var(--ease-out);
}
.ui-seg__item {
  position: relative; /* paint the label above the indicator */
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  cursor: pointer;
  line-height: 1;
  transition: color var(--duration-base) var(--ease-out);
}
.ui-seg--md .ui-seg__item { padding: 5px var(--space-3); font-size: var(--text-sm); }
.ui-seg--sm .ui-seg__item { height: 24px; padding: 0 var(--space-2); font-size: var(--text-sm); }
.ui-seg__item:hover:not(.is-on) { color: var(--color-text); }
.ui-seg__item.is-on { color: var(--color-text); }
.ui-seg__item:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
</style>
