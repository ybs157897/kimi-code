<!-- apps/kimi-web/src/components/chat/StatusGlyph.vue -->
<!-- Shared status glyph for dock list rows (todo + background bash/subagent tasks).
     One symbol per state, colored by state — keeps the two lists visually identical. -->
<script setup lang="ts">
export type StatusGlyphStatus = 'pending' | 'run' | 'done' | 'fail';

const props = defineProps<{ status: StatusGlyphStatus }>();

const GLYPH: Record<StatusGlyphStatus, string> = {
  pending: '○',
  run: '●',
  done: '✓',
  fail: '✗',
};
</script>

<template>
  <span class="status-glyph" :class="`s-${props.status}`" aria-hidden="true">
    <!-- Keyed on the status so a flip (pending→run→done/fail) swaps the glyph
         through a quick out-in settle instead of a hard character swap. The
         root's colour cross-fades on the same flip via its transition. -->
    <Transition name="glyph-flip" mode="out-in">
      <span :key="props.status" class="status-glyph-char">{{ GLYPH[props.status] }}</span>
    </Transition>
  </span>
</template>

<style scoped>
.status-glyph {
  flex: none;
  width: 16px;
  font-size: var(--text-base);
  line-height: 1;
  text-align: center;
  user-select: none;
  transition: color var(--duration-base) var(--ease-out);
}
/* inline-block so the flip's transform applies to the glyph character. */
.status-glyph-char { display: inline-block; }
.status-glyph.s-run { color: var(--color-accent); font-weight: 500; }
.status-glyph.s-done { color: var(--color-success); }
.status-glyph.s-fail { color: var(--color-danger); }
.status-glyph.s-pending { color: var(--color-text-faint); }

/* Status flip: the outgoing glyph steps aside and the incoming one settles
   with a micro-scale — quiet, easeOut-only, no bounce. No `appear`, so the
   initial mount renders exactly as it did before. */
.glyph-flip-enter-active,
.glyph-flip-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.glyph-flip-enter-from,
.glyph-flip-leave-to {
  opacity: 0;
  transform: scale(0.5);
}
</style>
