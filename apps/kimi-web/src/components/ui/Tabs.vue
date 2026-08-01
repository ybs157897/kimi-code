<!-- apps/kimi-web/src/components/ui/Tabs.vue -->
<!-- Design-system §03 Tabs: underlined tab list. The accent underline is a
     separate element that slides between tabs; ←/→ (and ↑/↓) + Home/End move
     and activate tabs via roving tabindex. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const itemRefs = ref<HTMLButtonElement[]>([]);

const activeIndex = computed(() => props.options.findIndex((o) => o.value === props.modelValue));

// Sliding underline: measured off the active tab (offsetLeft/offsetWidth are
// relative to .ui-tabs, the indicator's offsetParent). It is only rendered
// once the first measurement exists, so it can never animate on mount.
const indicator = ref<{ x: number; width: number } | null>(null);

function measure(): void {
  const el = activeIndex.value >= 0 ? itemRefs.value[activeIndex.value] : undefined;
  if (!el) {
    // Active value not in options: collapse the underline in place.
    if (indicator.value) indicator.value = { ...indicator.value, width: 0 };
    return;
  }
  indicator.value = { x: el.offsetLeft, width: el.offsetWidth };
}

// Roving tabindex: only the active tab is tabbable (first one as a fallback
// when the value is not in options).
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
// active tab / option list.
watch([() => props.modelValue, () => props.options], measure, { flush: 'post' });
</script>

<template>
  <div class="ui-tabs" role="tablist">
    <span
      v-if="indicator"
      class="ui-tabs__indicator"
      aria-hidden="true"
      :style="{ width: `${indicator.width}px`, transform: `translateX(${indicator.x}px)` }"
    />
    <button
      v-for="(opt, i) in options"
      :key="opt.value"
      ref="itemRefs"
      class="ui-tabs__item"
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
.ui-tabs { position: relative; display: flex; gap: 0; border-bottom: 1px solid var(--color-line); }
/* The underline replaced the active tab's border-bottom; bottom: -1px sits it
   exactly where that 2px border painted (over the list's 1px hairline). */
.ui-tabs__indicator {
  position: absolute;
  left: 0;
  bottom: -1px;
  height: 2px;
  background: var(--color-accent);
  pointer-events: none;
  transition: transform var(--duration-base) var(--ease-out),
    width var(--duration-base) var(--ease-out);
}
.ui-tabs__item {
  position: relative; /* paint the label above the indicator */
  padding: var(--space-2) 14px;
  margin-bottom: -1px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  cursor: pointer;
  transition: color var(--duration-base) var(--ease-out);
}
.ui-tabs__item:hover:not(.is-on) { color: var(--color-text); }
.ui-tabs__item.is-on { color: var(--color-accent); }
.ui-tabs__item:focus-visible { outline: none; box-shadow: var(--p-focus-ring); border-radius: var(--radius-xs); }
</style>
